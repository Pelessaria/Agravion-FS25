<?php

namespace App\Http\Controllers;

use App\Models\Workspace;
use App\Services\Fs25\ConnectorDeployService;
use App\Services\Fs25\ConnectorSnapshotService;
use App\Services\Fs25\HostAccessService;
use App\Services\Fs25\ModIconCacheService;
use App\Services\Fs25\RequiredModsService;
use App\Services\Fs25\WorkspaceFeedService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use InvalidArgumentException;
use Throwable;

class WorkspaceController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $rows = Workspace::query()->with(['hostAccess', 'savegames'])->orderBy('number')->orderBy('id')->get();

        return response()->json([
            'workspaces' => $rows->map(fn (Workspace $w) => $this->serialize($w))->values(),
        ]);
    }

    public function show(string $workspace): JsonResponse
    {
        $row = $this->findWorkspace($workspace);

        return response()->json([
            'workspace' => $this->serialize($row),
        ]);
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'min:2', 'max:40'],
        ]);

        $maxNumber = (int) Workspace::query()->max('number');
        $workspace = Workspace::query()->create([
            'display_name' => $data['name'],
            'number' => $maxNumber + 1,
            'lifecycle' => 'active',
            'link_state' => 'unpaired',
            'data_mode' => 'empty',
        ]);

        $pairingCode = Str::upper(Str::random(4).'-'.Str::random(4).'-'.Str::random(4));

        return response()->json([
            'workspace' => $this->serialize($workspace),
            'pairingCode' => $pairingCode,
        ], 201);
    }

    public function update(Request $request, string $workspace, WorkspaceFeedService $feeds): JsonResponse
    {
        $row = $this->findWorkspace($workspace);

        $data = $request->validate([
            'name' => ['sometimes', 'string', 'min:2', 'max:40'],
            'disabled' => ['sometimes', 'boolean'],
            'feedUrl' => ['sometimes', 'nullable', 'string', 'max:2048'],
            'keepCode' => ['sometimes', 'boolean'],
            'sync' => ['sometimes', 'boolean'],
        ]);

        if (array_key_exists('name', $data)) {
            $row->display_name = $data['name'];
            $row->save();
        }

        if (array_key_exists('disabled', $data)) {
            $row->lifecycle = $data['disabled'] ? 'disabled' : 'active';
            $row->save();
        }

        if (array_key_exists('feedUrl', $data)) {
            try {
                $feeds->configure(
                    $row,
                    $data['feedUrl'],
                    (bool) ($data['keepCode'] ?? false),
                );
                $row->refresh();
            } catch (InvalidArgumentException $e) {
                throw ValidationException::withMessages([
                    'feedUrl' => [$e->getMessage()],
                ]);
            }

            if ($request->boolean('sync') && filled($row->feed_base_url) && $row->feedCode()) {
                try {
                    $feeds->sync($row, true);
                    $row->refresh();
                } catch (Throwable $e) {
                    // 200 so the SPA still receives the saved workspace (credentials kept).
                    return response()->json([
                        'workspace' => $this->serialize($row->fresh()),
                        'ok' => false,
                        'error' => $e->getMessage(),
                    ]);
                }
            }
        }

        return response()->json([
            'workspace' => $this->serialize($row->fresh()),
            'ok' => true,
        ]);
    }

    public function sync(Request $request, string $workspace, WorkspaceFeedService $feeds): JsonResponse
    {
        $row = $this->findWorkspace($workspace);
        $light = $request->boolean('light', true);

        try {
            $feeds->sync($row, $light);
        } catch (Throwable $e) {
            return response()->json([
                'ok' => false,
                'error' => $e->getMessage(),
                'workspace' => $this->serialize($row->fresh()),
            ]);
        }

        return response()->json([
            'ok' => true,
            'workspace' => $this->serialize($row->fresh()),
        ]);
    }

    public function fields(string $workspace, ConnectorSnapshotService $connector): JsonResponse
    {
        $row = $this->findWorkspace($workspace);
        if ($row->lifecycle === 'disabled') {
            return response()->json([
                'ok' => false,
                'error' => 'disabled',
                'mapSize' => null,
                'precisionFarming' => null,
                'geometryAt' => null,
                'stateAt' => null,
                'fields' => [],
            ]);
        }

        return response()->json($connector->readFields($row));
    }

    public function fruitIcon(string $workspace, string $fruitKey, ConnectorSnapshotService $connector): BinaryFileResponse|Response
    {
        $row = $this->findWorkspace($workspace);
        $path = $connector->fruitIconPath($row, $fruitKey);
        if ($path === null) {
            return response('', 404);
        }

        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        $mime = match ($ext) {
            'jpg', 'jpeg' => 'image/jpeg',
            'webp' => 'image/webp',
            default => 'image/png',
        };

        return response()->file($path, [
            'Content-Type' => $mime,
            'Cache-Control' => 'private, max-age=86400',
        ]);
    }

    public function vehicles(string $workspace, WorkspaceFeedService $feeds): JsonResponse
    {
        $row = $this->findWorkspace($workspace);
        $result = $feeds->fetchVehicles($row);

        return response()->json([
            'ok' => $result['ok'],
            'error' => $result['error'],
            'fetchedAt' => $result['fetchedAt'],
            'vehicles' => $result['vehicles'],
            'farms' => $result['farms'],
            'workspace' => $this->serialize($row->fresh()),
        ]);
    }

    public function syncConnectorIcons(string $workspace, ConnectorSnapshotService $connector): JsonResponse
    {
        $row = $this->findWorkspace($workspace);
        $result = $connector->syncStoreIconsIfDue($row, 0);

        $progress = ($result['downloaded'] ?? 0) > 0 || ($result['converted'] ?? 0) > 0;
        $clean = $result['skipped'] === null
            || in_array($result['skipped'], ['unchanged', 'convert_cooldown'], true);

        return response()->json([
            'ok' => $clean || $progress,
            'iconSync' => $result,
        ]);
    }

    public function farms(Request $request, string $workspace, WorkspaceFeedService $feeds): JsonResponse
    {
        $row = $this->findWorkspace($workspace);
        $farms = $request->boolean('sync')
            ? $feeds->syncFarmsFromFeed($row)
            : $feeds->listFarms($row);

        return response()->json([
            'farms' => $farms,
            'workspace' => $this->serialize($row->fresh()),
        ]);
    }

    public function connectorPackage(ConnectorDeployService $deploy): BinaryFileResponse|JsonResponse
    {
        try {
            $path = $deploy->packagePath();
        } catch (Throwable $e) {
            return response()->json(['message' => $e->getMessage()], 404);
        }

        return response()->download($path, ConnectorDeployService::MOD_ZIP, [
            'Content-Type' => 'application/zip',
        ]);
    }

    public function connectorPackageMeta(ConnectorDeployService $deploy): JsonResponse
    {
        try {
            $path = $deploy->packagePath();
            $bytes = filesize($path) ?: 0;
        } catch (Throwable $e) {
            return response()->json([
                'available' => false,
                'error' => $e->getMessage(),
                'version' => null,
                'fileName' => ConnectorDeployService::MOD_ZIP,
            ]);
        }

        return response()->json([
            'available' => true,
            'error' => null,
            'version' => $deploy->packageVersion(),
            'fileName' => ConnectorDeployService::MOD_ZIP,
            'bytes' => $bytes,
        ]);
    }

    public function deployConnector(Request $request, string $workspace, ConnectorDeployService $deploy): JsonResponse
    {
        $row = $this->findWorkspace($workspace);
        $modsPath = $request->string('modsPath')->toString() ?: null;
        $result = $deploy->deploy($row, $modsPath);

        return response()->json($result, $result['ok'] ? 200 : 422);
    }

    public function requiredMods(string $workspace, RequiredModsService $mods): JsonResponse
    {
        $row = $this->findWorkspace($workspace);

        return response()->json($mods->status($row));
    }

    public function connectorIcon(
        string $workspace,
        string $modKey,
        ConnectorSnapshotService $connector,
        ModIconCacheService $icons,
    ): BinaryFileResponse|Response {
        $row = $this->findWorkspace($workspace);
        // Local cache only — never FTP from an <img> request.
        $path = $icons->localPath($row, $modKey) ?? $connector->cachedIconPath($row, $modKey);
        if ($path === null || ! is_file($path)) {
            return response('Icon not found.', 404)->header('Content-Type', 'text/plain; charset=UTF-8');
        }

        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        if ($ext === 'dds') {
            $png = \App\Services\Fs25\DdsToPng::convert((string) file_get_contents($path));
            if ($png === null) {
                return response('Icon convert failed.', 404)->header('Content-Type', 'text/plain; charset=UTF-8');
            }
            $converted = preg_replace('/\.dds$/i', '.png', $path) ?? ($path.'.png');
            @file_put_contents($converted, $png);

            return response($png, 200, [
                'Content-Type' => 'image/png',
                'Cache-Control' => 'private, max-age=86400',
            ]);
        }

        $mime = match ($ext) {
            'jpg', 'jpeg' => 'image/jpeg',
            'webp' => 'image/webp',
            'png' => 'image/png',
            default => 'application/octet-stream',
        };

        return response()->file($path, [
            'Content-Type' => $mime,
            'Cache-Control' => 'private, max-age=86400',
        ]);
    }

    public function map(Request $request, string $workspace, WorkspaceFeedService $feeds): Response
    {
        $row = $this->findWorkspace($workspace);
        $size = max(128, min(1024, (int) $request->query('size', 384)));
        $quality = max(30, min(80, (int) $request->query('quality', 45)));

        try {
            $jpeg = $feeds->fetchMapJpeg($row, $quality, $size);
        } catch (Throwable $e) {
            return response($e->getMessage(), 502)
                ->header('Content-Type', 'text/plain; charset=UTF-8');
        }

        return response($jpeg, 200, [
            'Content-Type' => 'image/jpeg',
            'Cache-Control' => 'private, max-age='.($size >= 512 ? '120' : '60'),
        ]);
    }

    public function updateHostAccess(Request $request, string $workspace, HostAccessService $hosts): JsonResponse
    {
        $row = $this->findWorkspace($workspace);

        $data = $request->validate([
            'protocol' => ['required', 'string', 'in:sftp,ftps,ftp'],
            'host' => ['required', 'string', 'max:255'],
            'port' => ['nullable', 'integer', 'min:1', 'max:65535'],
            'username' => ['required', 'string', 'max:255'],
            'password' => ['nullable', 'string', 'max:512'],
            'keepPassword' => ['sometimes', 'boolean'],
            'remoteRoot' => ['nullable', 'string', 'max:512'],
            'remoteSavegamePath' => ['nullable', 'string', 'max:512'],
            'remoteModSettingsPath' => ['nullable', 'string', 'max:512'],
            'insecureAck' => ['sometimes', 'boolean'],
            'probe' => ['sometimes', 'boolean'],
        ]);

        try {
            $hosts->configure($row, $data);
        } catch (InvalidArgumentException $e) {
            throw ValidationException::withMessages([
                'hostAccess' => [$e->getMessage()],
            ]);
        }

        $farms = [];
        $savegames = [];
        $ok = true;
        $error = null;
        if ($request->boolean('probe', true)) {
            $result = $hosts->probeAndSyncFarms($row);
            $ok = $result['ok'];
            $error = $result['error'];
            $farms = $result['farms'];
            $savegames = $result['savegames'];
        }

        $row->load(['hostAccess', 'savegames']);

        return response()->json([
            'ok' => $ok,
            'error' => $error,
            'workspace' => $this->serialize($row),
            'farms' => $farms,
            'savegames' => $savegames !== [] ? $savegames : $hosts->serializeSavegames($row),
        ]);
    }

    public function probeHostAccess(string $workspace, HostAccessService $hosts): JsonResponse
    {
        $row = $this->findWorkspace($workspace);
        $result = $hosts->probeAndSyncFarms($row);
        $row->load(['hostAccess', 'savegames']);

        return response()->json([
            'ok' => $result['ok'],
            'error' => $result['error'],
            'workspace' => $this->serialize($row),
            'farms' => $result['farms'],
            'savegames' => $result['savegames'],
        ]);
    }

    public function selectSavegame(Request $request, string $workspace, HostAccessService $hosts): JsonResponse
    {
        $row = $this->findWorkspace($workspace);
        $data = $request->validate([
            'savegameId' => ['required'],
        ]);
        $result = $hosts->selectSavegame($row, $data['savegameId']);
        $row->load(['hostAccess', 'savegames']);

        return response()->json([
            'ok' => $result['ok'],
            'error' => $result['error'],
            'workspace' => $this->serialize($row),
            'farms' => $result['farms'],
            'savegames' => $result['savegames'],
        ]);
    }

    public function deleteHostAccess(string $workspace, HostAccessService $hosts): JsonResponse
    {
        $row = $this->findWorkspace($workspace);
        $hosts->clear($row);
        $row->unsetRelation('hostAccess');

        return response()->json([
            'ok' => true,
            'workspace' => $this->serialize($row->fresh()),
        ]);
    }

    private function findWorkspace(string $key): Workspace
    {
        $row = Workspace::query()
            ->with(['hostAccess', 'savegames'])
            ->where(function ($query) use ($key) {
                $query->where('public_id', $key)->orWhere('id', $key);
            })
            ->first();

        if (! $row) {
            abort(404, 'Workspace not found.');
        }

        return $row;
    }

    /**
     * @return array<string, mixed>
     */
    private function serialize(Workspace $w, ?HostAccessService $hosts = null): array
    {
        $disabled = $w->lifecycle === 'disabled';
        $feedConfigured = filled($w->feed_code_encrypted) && filled($w->feed_base_url);
        $notice = null;
        if ($disabled) {
            $notice = 'disabled';
        } elseif ($w->link_state === 'unpaired' || ! $feedConfigured) {
            $notice = 'unpaired';
        } elseif ($w->link_state === 'offline' || $w->link_state === 'error') {
            // Host unreachable — not a missing feed code.
            $notice = 'offline';
        }

        $online = $w->link_state === 'online';
        $hosts ??= app(HostAccessService::class);
        $hostAccess = $hosts->serialize($w->hostAccess);
        $savegames = $hosts->serializeSavegames($w);

        return [
            'id' => $w->public_id,
            'number' => $w->number,
            'name' => $w->display_name,
            'linkState' => $w->link_state,
            'disabled' => $disabled,
            'mapName' => $w->map_name,
            'playersOnline' => $w->players_online,
            'playerCapacity' => $w->player_capacity,
            'gameTime' => $this->formatGameTime($w->day_time_ms),
            'gameVersion' => $w->game_version,
            'lastSeenAt' => optional($w->last_seen_at)?->toIso8601String(),
            'lastSyncAt' => optional($w->last_sync_at)?->toIso8601String(),
            'connectorVersion' => $w->connector_version,
            'notice' => $notice,
            // Origin only — never the feed code.
            'feedUrl' => $w->feed_base_url ?? '',
            'feedConfigured' => $feedConfigured,
            // Only when online — avoid long-hanging map fetches for dead hosts.
            'mapPreviewPath' => ($feedConfigured && $online)
                ? '/api/workspaces/'.$w->public_id.'/map'
                : null,
            'dataMode' => $w->data_mode,
            'statusNote' => $w->status_note,
            'hostAccess' => $hostAccess,
            'savegames' => $savegames,
            'activeSavegameId' => collect($savegames)->firstWhere('active')['id'] ?? null,
        ];
    }

    private function formatGameTime(mixed $dayTimeMs): ?string
    {
        if ($dayTimeMs === null || $dayTimeMs === '') {
            return null;
        }
        if (! is_numeric($dayTimeMs)) {
            return null;
        }
        $ms = (int) $dayTimeMs;
        if ($ms < 0) {
            return null;
        }
        // Giants dayTime is milliseconds into the in-game day.
        $totalMinutes = intdiv($ms, 60000) % (24 * 60);
        $hours = intdiv($totalMinutes, 60);
        $minutes = $totalMinutes % 60;

        return sprintf('%02d:%02d', $hours, $minutes);
    }
}
