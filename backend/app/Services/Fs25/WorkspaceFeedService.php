<?php

namespace App\Services\Fs25;

use App\Models\GameFarm;
use App\Support\GameFarms;
use App\Models\Workspace;
use App\Models\WorkspaceSavegame;
use InvalidArgumentException;
use RuntimeException;
use Throwable;

/**
 * Configure and sync a workspace against the Giants dedicated-server feed.
 * Feed codes stay encrypted on the model and never leave this service in responses.
 */
final class WorkspaceFeedService
{
    public function __construct(
        private readonly WorkspaceFeedSync $sync,
    ) {}

    public function configure(Workspace $workspace, ?string $feedUrl, bool $keepExistingCode = false): Workspace
    {
        $trimmed = trim((string) $feedUrl);

        if ($trimmed === '') {
            $workspace->feed_base_url = null;
            $workspace->setFeedCode(null);
            $workspace->link_state = 'unpaired';
            $workspace->data_mode = 'empty';
            $workspace->map_name = null;
            $workspace->game_version = null;
            $workspace->day_time_ms = null;
            $workspace->map_size = null;
            $workspace->players_online = null;
            $workspace->player_capacity = null;
            $workspace->status_note = null;
            $workspace->save();

            return $workspace;
        }

        try {
            if (str_contains($trimmed, 'code=')) {
                $client = DedicatedServerFeedClient::fromFeedUrl($trimmed);
                $workspace->feed_base_url = $client->baseUrl();
                $workspace->setFeedCode($client->code());
            } else {
                if (! $keepExistingCode || $workspace->feedCode() === null) {
                    throw new InvalidArgumentException(
                        'Feed-URL muss ?code=… enthalten (oder der Code ist bereits gespeichert).'
                    );
                }
                $client = DedicatedServerFeedClient::fromParts($trimmed, $workspace->feedCode());
                $workspace->feed_base_url = $client->baseUrl();
            }
        } catch (InvalidArgumentException $e) {
            throw $e;
        }

        if ($workspace->link_state === 'unpaired') {
            $workspace->link_state = 'offline';
        }
        $workspace->status_note = null;
        $workspace->save();

        return $workspace;
    }

    /**
     * @param  bool  $light  Stats-only probe (short timeout). Full sync pulls savegames too.
     */
    public function sync(Workspace $workspace, bool $light = false): Workspace
    {
        if ($workspace->lifecycle === 'disabled') {
            throw new RuntimeException('Workspace is disabled.');
        }

        $base = trim((string) $workspace->feed_base_url);
        $code = $workspace->feedCode();
        if ($base === '' || $code === null || $code === '') {
            throw new RuntimeException('Feed is not configured.');
        }

        try {
            $timeout = $light ? 4 : 20;
            $client = DedicatedServerFeedClient::fromParts($base, $code, $timeout);
            $snapshot = $light ? $client->fetchLightSnapshot() : $client->fetchSnapshot();
            $workspace = $this->sync->apply($workspace, $snapshot);

            if (! $light) {
                // Full snapshot already loaded vehicles savegame XML into counts; re-fetch for farm IDs.
                $vehiclesXml = $client->fetchSavegame('vehicles');
                $this->syncFarmStubs($workspace, self::farmIdsFromVehiclesXml($vehiclesXml));
            }

            return $workspace;
        } catch (Throwable $e) {
            $workspace->link_state = 'offline';
            $workspace->status_note = mb_substr($e->getMessage(), 0, 240);
            $workspace->last_sync_at = now();
            $workspace->save();

            throw new RuntimeException($e->getMessage(), 0, $e);
        }
    }

    /**
     * Discover farm stubs from savegame vehicles.xml (IDs only; names via FTP/mod later).
     *
     * @return list<array<string, mixed>>
     */
    public function syncFarmsFromFeed(Workspace $workspace): array
    {
        $base = trim((string) $workspace->feed_base_url);
        $code = $workspace->feedCode();
        if ($base === '' || $code === null || $code === '') {
            return $this->serializeFarms($workspace);
        }

        try {
            $client = DedicatedServerFeedClient::fromParts($base, $code, 8);
            $vehiclesXml = $client->fetchSavegame('vehicles');
            $this->syncFarmStubs($workspace, self::farmIdsFromVehiclesXml($vehiclesXml));
        } catch (Throwable) {
            // Keep previously known stubs when host is briefly unreachable.
        }

        return $this->serializeFarms($workspace);
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function listFarms(Workspace $workspace): array
    {
        return $this->serializeFarms($workspace);
    }

    /**
     * Live vehicles from stats JSON + farm stub discovery from savegame.
     *
     * @return array{ok: bool, error: string|null, fetchedAt: string|null, vehicles: list<array<string, mixed>>, farms: list<array<string, mixed>>}
     */
    public function fetchVehicles(Workspace $workspace): array
    {
        if ($workspace->lifecycle === 'disabled') {
            return [
                'ok' => false,
                'error' => 'Workspace is disabled.',
                'fetchedAt' => null,
                'vehicles' => [],
                'farms' => $this->serializeFarms($workspace),
            ];
        }

        $base = trim((string) $workspace->feed_base_url);
        $code = $workspace->feedCode();
        if ($base === '' || $code === null || $code === '') {
            return [
                'ok' => false,
                'error' => 'Feed is not configured.',
                'fetchedAt' => null,
                'vehicles' => [],
                'farms' => [],
            ];
        }

        try {
            $client = DedicatedServerFeedClient::fromParts($base, $code, 8);
            $snapshot = $client->fetchLightSnapshot();
            $this->sync->apply($workspace, $snapshot);

            $saveVehicles = [];
            try {
                $vehiclesXml = $client->fetchSavegame('vehicles');
                $this->syncFarmStubs($workspace, self::farmIdsFromVehiclesXml($vehiclesXml));
                $saveVehicles = VehiclesXmlParser::parse($vehiclesXml);
            } catch (Throwable) {
                // Positions still useful without farm stubs / matching.
            }

            $connector = ['vehicles' => [], 'basePath' => null];
            $connectorService = new ConnectorSnapshotService;
            try {
                // Local connector cache only — cron owns FTP.
                $connector = $connectorService->readVehicles($workspace);
            } catch (Throwable) {
                // Host connector files are optional enrichment.
            }

            $metaVehicles = ConnectorSnapshotService::mergeMeta($connector['vehicles'], $saveVehicles);

            // Savegame/connector = inventory + farmId; stats = live name/position.
            $enriched = VehicleFarmMatcher::mergeInventory($snapshot->vehicles, $metaVehicles);

            $iconCache = new ModIconCacheService;

            $vehicles = [];
            foreach ($enriched as $index => $vehicle) {
                $unique = $vehicle['uniqueId'] ?? null;
                $filename = $vehicle['filename'] ?? null;
                $storeKey = $vehicle['storeKey'] ?? StoreKey::fromFilename(is_string($filename) ? $filename : null);
                $modKey = $vehicle['modKey'] ?? ModKey::fromFilename(is_string($filename) ? $filename : null);
                // PNG preferred; DDS still gets a URL — connectorIcon converts on first request.
                $iconUrl = null;
                if (is_string($storeKey) && $storeKey !== ''
                    && ($iconCache->localPath($workspace, $storeKey) !== null
                        || $iconCache->localDdsPath($workspace, $storeKey) !== null)) {
                    $iconUrl = $iconCache->publicUrl($workspace, $storeKey);
                }
                $modIconUrl = null;
                if (is_string($modKey) && $modKey !== ''
                    && ($iconCache->localPath($workspace, $modKey) !== null
                        || $iconCache->localDdsPath($workspace, $modKey) !== null)) {
                    $modIconUrl = $iconCache->publicUrl($workspace, $modKey);
                }
                $brand = BrandName::resolve(
                    isset($vehicle['brand']) && is_string($vehicle['brand']) ? $vehicle['brand'] : null,
                    is_string($filename) ? $filename : null,
                    is_string($modKey) ? $modKey : null,
                    isset($vehicle['name']) && is_string($vehicle['name']) ? $vehicle['name'] : null,
                );
                $brandKey = BrandName::iconKey(
                    isset($vehicle['brandKey']) && is_string($vehicle['brandKey']) ? $vehicle['brandKey'] : null,
                    isset($vehicle['brand']) && is_string($vehicle['brand']) ? $vehicle['brand'] : null,
                );
                $brandIconUrl = null;
                if (is_string($brandKey) && $brandKey !== ''
                    && ($iconCache->brandLocalPath($workspace, $brandKey) !== null
                        || $iconCache->brandLocalDdsPath($workspace, $brandKey) !== null)) {
                    $brandIconUrl = $iconCache->brandPublicUrl($workspace, $brandKey);
                }
                $vehicles[] = [
                    'id' => $unique
                        ? 'feed-'.$workspace->public_id.'-'.$unique
                        : 'feed-'.$workspace->public_id.'-'.$index,
                    'workspaceId' => $workspace->public_id,
                    'name' => $vehicle['name'] ?? 'Fahrzeug',
                    'category' => self::mapVehicleCategory(
                        $vehicle['category'] ?? null,
                        $vehicle['type'] ?? null,
                        is_string($filename) ? $filename : null,
                        isset($vehicle['name']) && is_string($vehicle['name']) ? $vehicle['name'] : null,
                        self::nullableNumber($vehicle['fuelCapacity'] ?? null),
                    ),
                    'farmId' => $vehicle['farmId'] ?? null,
                    'storeKey' => $storeKey,
                    'modKey' => $modKey,
                    'brand' => $brand,
                    'brandKey' => $brandKey,
                    'filename' => is_string($filename) && $filename !== '' ? $filename : null,
                    'iconUrl' => $iconUrl,
                    'modIconUrl' => $modIconUrl,
                    'brandIconUrl' => $brandIconUrl,
                    'x' => $vehicle['x'] ?? null,
                    'y' => $vehicle['y'] ?? null,
                    'z' => $vehicle['z'] ?? null,
                    'fuel' => self::nullableNumber($vehicle['fuel'] ?? null),
                    'fuelCapacity' => self::nullableNumber($vehicle['fuelCapacity'] ?? null),
                    'defLevel' => self::nullableNumber($vehicle['defLevel'] ?? null),
                    'defCapacity' => self::nullableNumber($vehicle['defCapacity'] ?? null),
                    'wear' => self::nullableNumber($vehicle['wear'] ?? null),
                    'plate' => isset($vehicle['plate']) && is_string($vehicle['plate']) && $vehicle['plate'] !== '' ? $vehicle['plate'] : null,
                    'fill' => null,
                    'hours' => $vehicle['hours'] ?? null,
                    'observedAt' => $snapshot->fetchedAtUtc,
                ];
            }

            return [
                'ok' => true,
                'error' => null,
                'fetchedAt' => $snapshot->fetchedAtUtc,
                'vehicles' => $vehicles,
                'farms' => $this->serializeFarms($workspace),
            ];
        } catch (Throwable $e) {
            $workspace->link_state = 'offline';
            $workspace->status_note = mb_substr($e->getMessage(), 0, 240);
            $workspace->last_sync_at = now();
            $workspace->save();

            return [
                'ok' => false,
                'error' => $e->getMessage(),
                'fetchedAt' => null,
                'vehicles' => [],
                'farms' => $this->serializeFarms($workspace),
            ];
        }
    }

    public function fetchMapJpeg(Workspace $workspace, int $quality = 45, int $size = 384): string
    {
        $base = trim((string) $workspace->feed_base_url);
        $code = $workspace->feedCode();
        if ($base === '' || $code === null || $code === '') {
            throw new RuntimeException('Feed is not configured.');
        }

        $client = DedicatedServerFeedClient::fromParts($base, $code, 4);

        return $client->fetchMapJpeg($quality, $size);
    }

    /**
     * @param  list<int>  $gameFarmIds
     */
    public function syncFarmStubs(Workspace $workspace, array $gameFarmIds): void
    {
        $ids = array_values(array_unique(array_filter(
            $gameFarmIds,
            static fn (mixed $id): bool => is_int($id) && $id > 0
        )));

        $activeSavegameId = WorkspaceSavegame::query()
            ->where('workspace_id', $workspace->id)
            ->where('is_active', true)
            ->value('id');
        $activeSavegameId = $activeSavegameId !== null ? (int) $activeSavegameId : null;

        GameFarms::purgeDuplicateStubs($workspace);

        foreach ($ids as $gameFarmId) {
            $existing = GameFarm::query()
                ->where('workspace_id', $workspace->id)
                ->where('game_farm_id', $gameFarmId)
                ->where(function ($q) use ($activeSavegameId) {
                    if ($activeSavegameId !== null) {
                        $q->where('workspace_savegame_id', $activeSavegameId)
                            ->orWhereNull('workspace_savegame_id');
                    } else {
                        $q->whereNull('workspace_savegame_id');
                    }
                })
                ->orderByRaw('CASE WHEN workspace_savegame_id IS NULL THEN 1 ELSE 0 END')
                ->first();

            if ($existing) {
                if ($activeSavegameId !== null && $existing->workspace_savegame_id === null) {
                    // Claim legacy stub for active slot; collapse if a named row already exists.
                    $named = GameFarm::query()
                        ->where('workspace_id', $workspace->id)
                        ->where('workspace_savegame_id', $activeSavegameId)
                        ->where('game_farm_id', $gameFarmId)
                        ->first();
                    if ($named) {
                        $existing->delete();
                    } else {
                        $existing->workspace_savegame_id = $activeSavegameId;
                        $existing->save();
                    }
                }

                continue;
            }

            GameFarm::query()->create([
                'workspace_id' => $workspace->id,
                'workspace_savegame_id' => $activeSavegameId,
                'game_farm_id' => $gameFarmId,
                'display_name' => null,
                'money' => null,
            ]);
        }

        if ($ids === []) {
            return;
        }

        // Drop auto-stubs that vanished; keep rows that already have a real name (FTP/mod).
        GameFarm::query()
            ->where('workspace_id', $workspace->id)
            ->where('workspace_savegame_id', $activeSavegameId)
            ->whereNull('display_name')
            ->whereNotIn('game_farm_id', $ids)
            ->delete();
    }

    /**
     * @return list<int>
     */
    public static function farmIdsFromVehiclesXml(string $xml): array
    {
        if (trim($xml) === '') {
            return [];
        }

        if (! preg_match_all('/\bfarmId="(\d+)"/i', $xml, $matches)) {
            return [];
        }

        $ids = array_map(static fn (string $v): int => (int) $v, $matches[1]);

        return array_values(array_unique(array_filter($ids, static fn (int $id): bool => $id > 0)));
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function serializeFarms(Workspace $workspace): array
    {
        return GameFarms::serialize($workspace);
    }

    private static function nullableNumber(mixed $value): ?float
    {
        if (! is_numeric($value)) {
            return null;
        }

        return (float) $value;
    }

    private static function mapVehicleCategory(?string $category, ?string $type, ?string $filename = null, ?string $name = null, ?float $fuelCapacity = null): string
    {
        $shop = self::shopBucket($category);
        $objectHay = mb_strtolower(trim(($filename ?? '').' '.($name ?? '')), 'UTF-8');
        $hay = mb_strtolower(trim(($category ?? '').' '.($type ?? '').' '.$objectHay), 'UTF-8');
        // A shovel or weight keeps its own name even when the matched shop row says tractor.
        if (self::hayHas($objectHay, ['fork', 'gabel', 'schaufel', 'shovel', 'frontloader', 'frontlader', 'weight', 'gewicht', 'adapter', 'triangle', 'cutter', 'header', 'pickup', 'orbis', 'plow', 'pflug', 'cultivat', 'grubber', 'mower', 'mäher', 'tedder', 'zetter', 'windrow', 'schwader', 'baler', 'presse', 'sprayer', 'spritze', 'seeder', 'sämaschine', 'planter'])) {
            return 'tool';
        }
        if ($shop !== null) {
            return $shop;
        }
        if (self::hayHas($hay, ['pallet', '/palette', 'bigbag'])) {
            return 'pallet';
        }
        if (self::hayHas($hay, ['harvest', 'mähdresch', 'maehdresch', 'combine', 'häcksl', 'haecksl'])) {
            return 'harvester';
        }
        if (self::hayHas($hay, ['tractor', 'traktor', 'truck', 'lkw', 'wheelloader', 'radlader', 'telehandler', 'teleskop', 'forklift', 'stapler', 'frontloadervehicle'])) {
            return 'tractor';
        }
        if (self::hayHas($hay, ['trailer', 'anhäng', 'anhaeng', 'wagon', 'kipper', 'tipper', 'ladewagen', 'dolly'])) {
            return 'trailer';
        }
        if ($fuelCapacity !== null && $fuelCapacity > 1) {
            return 'tractor';
        }

        return 'tool';
    }

    /**
     * Shop category ids from the vehicle, when the connector or the stats feed has one.
     */
    private static function shopBucket(?string $value): ?string
    {
        $token = preg_replace('/[^a-z0-9]+/', '', strtolower((string) $value)) ?? '';
        if ($token === '') {
            return null;
        }
        // The stats feed appends a size letter: TRACTORSM, TRACTORSL, TRACTORSS.
        if (str_starts_with($token, 'tractors') || str_starts_with($token, 'traktor')) {
            return 'tractor';
        }
        if (self::tokenIs($token, ['trucks', 'truck', 'lkw', 'cars', 'car', 'pkw', 'wheelloaders', 'wheelloader', 'telehandlers', 'telehandler', 'skidsteerloaders', 'skidsteerloader', 'forklifts', 'forklift', 'frontloadervehicles', 'frontloadervehicle'])) {
            return 'tractor';
        }
        if (self::tokenIs($token, ['harvesters', 'harvester', 'forageharvesters', 'forageharvester', 'beetharvesters', 'beetharvester', 'potatoharvesters', 'potatoharvester', 'cottonharvesters', 'cottonharvester', 'sugarcaneharvesters', 'sugarcaneharvester', 'vegetableharvesters', 'vegetableharvester', 'combines', 'combine'])) {
            return 'harvester';
        }
        if (self::tokenIs($token, ['trailers', 'trailer', 'augerwagons', 'augerwagon', 'foragewagons', 'foragewagon', 'loaderwagons', 'loaderwagon', 'lowloaders', 'lowloader', 'dollies', 'dolly', 'tippers', 'tipper'])) {
            return 'trailer';
        }
        if (self::tokenIs($token, ['pallets', 'pallet', 'bigbags', 'bigbag'])) {
            return 'pallet';
        }
        if (self::tokenIs($token, ['cutters', 'cutter', 'cornheaders', 'cornheader', 'headers', 'header', 'weights', 'weight', 'frontloadertools', 'frontloadertool', 'frontloaders', 'frontloader'])) {
            return 'tool';
        }

        return null;
    }

    /**
     * @param  list<string>  $ids
     */
    private static function tokenIs(string $token, array $ids): bool
    {
        foreach ($ids as $id) {
            if ($token === $id || str_starts_with($token, $id)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param  list<string>  $needles
     */
    private static function hayHas(string $hay, array $needles): bool
    {
        foreach ($needles as $needle) {
            if ($needle !== '' && str_contains($hay, $needle)) {
                return true;
            }
        }

        return false;
    }
}
