<?php

namespace App\Services\Fs25;

use App\Models\ModuleGrant;
use App\Models\User;
use App\Models\Workspace;

final class ModuleGrantService
{
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
            if ($workspace === null || ! in_array($grant->access, ['read', 'write'], true)) {
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
