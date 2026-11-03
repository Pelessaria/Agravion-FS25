<?php

namespace App\Services\Fs25;

use App\Models\ModuleGrant;
use App\Models\User;
use App\Models\Workspace;

final class ModuleGrantService
{
    /** @var list<string> */
    public const SERVER_CAPS = ['control', 'mods', 'log'];

    /**
     * @return array{control: bool, mods: bool, log: bool}
     */
    public static function serverFlags(?string $access): array
    {
        if ($access === 'write') {
            return ['control' => true, 'mods' => true, 'log' => true];
        }
        if ($access === 'read') {
            return ['control' => false, 'mods' => true, 'log' => true];
        }
        $parts = array_flip(array_filter(array_map(trim(...), explode(',', (string) $access))));

        return [
            'control' => isset($parts['control']),
            'mods' => isset($parts['mods']),
            'log' => isset($parts['log']),
        ];
    }

    public static function encodeServerFlags(string $access): ?string
    {
        if ($access === 'none' || trim($access) === '') {
            return null;
        }
        $flags = self::serverFlags($access);
        $on = [];
        foreach (self::SERVER_CAPS as $cap) {
            if ($flags[$cap]) {
                $on[] = $cap;
            }
        }

        return $on === [] ? null : implode(',', $on);
    }

    /**
     * @return array{control: bool, mods: bool, log: bool}
     */
    public function serverFlagsFor(?User $user, Workspace $workspace): array
    {
        if ($user === null) {
            return ['control' => false, 'mods' => false, 'log' => false];
        }
        if (($user->global_role ?? 'admin') !== 'member') {
            return ['control' => true, 'mods' => true, 'log' => true];
        }
        $grant = ModuleGrant::query()
            ->where('user_id', $user->id)
            ->where('workspace_id', $workspace->id)
            ->where('module_id', 'server')
            ->first();

        return self::serverFlags($grant?->access);
    }

    public function serverAllows(?User $user, Workspace $workspace, string $cap): bool
    {
        $flags = $this->serverFlagsFor($user, $workspace);
        if ($cap === 'any') {
            return $flags['control'] || $flags['mods'] || $flags['log'];
        }

        return $flags[$cap] ?? false;
    }

    public function access(?User $user, Workspace $workspace, string $module): ?string
    {
        if ($user === null) {
            return null;
        }
        if (($user->global_role ?? 'admin') !== 'member') {
            return 'write';
        }
        $grant = ModuleGrant::query()
            ->where('user_id', $user->id)
            ->where('workspace_id', $workspace->id)
            ->where('module_id', $module)
            ->first();
        if ($grant === null || ! in_array($grant->access, ['read', 'write'], true)) {
            return null;
        }

        return $grant->access;
    }

    public function allows(?User $user, Workspace $workspace, string $module, string $need): bool
    {
        $access = $this->access($user, $workspace, $module);
        $rank = ['read' => 1, 'write' => 2];

        return ($rank[$access] ?? 0) >= ($rank[$need] ?? 9);
    }

    /**
     * @return list<array{workspaceId: string, role: string, modules: list<array{moduleId: string, access: string}>}>
     */
    public function membershipsFor(User $user): array
    {
        if (($user->global_role ?? 'admin') !== 'member') {
            return [];
        }
        $grants = ModuleGrant::query()->where('user_id', $user->id)->get();
        $workspaceIds = $grants->pluck('workspace_id')->unique()->all();
        $workspaces = Workspace::query()->whereIn('id', $workspaceIds)->get()->keyBy('id');
        $grouped = [];
        foreach ($grants as $grant) {
            $workspace = $workspaces->get($grant->workspace_id);
            if ($workspace === null) {
                continue;
            }
            $serverGrant = $grant->module_id === 'server' && self::encodeServerFlags((string) $grant->access) !== null;
            if (! $serverGrant && ! in_array($grant->access, ['read', 'write'], true)) {
                continue;
            }
            $grouped[$workspace->public_id][] = [
                'moduleId' => $grant->module_id,
                'access' => $grant->access,
            ];
        }
        $memberships = [];
        foreach ($grouped as $publicId => $modules) {
            $write = collect($modules)->contains(static fn (array $module): bool => $module['access'] === 'write');
            $memberships[] = [
                'workspaceId' => $publicId,
                'role' => $write ? 'operator' : 'viewer',
                'modules' => array_values($modules),
            ];
        }

        return $memberships;
    }
}
