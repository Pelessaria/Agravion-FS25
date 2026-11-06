<?php

namespace App\Http\Controllers;

use App\Services\InstanceSchedule;
use App\Services\Update\GithubUpdateService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Throwable;

class SystemUpdateController extends Controller
{
    public function status(Request $request, GithubUpdateService $updates): JsonResponse
    {
        if (! $this->isAdmin($request)) {
            return response()->json(['message' => 'Forbidden.'], 403);
        }

        try {
            return response()->json($updates->status());
        } catch (Throwable $e) {
            // Soft-fail: keep HTTP 200 so the SPA does not treat this as "no backend".
            return response()->json([
                'enabled' => (bool) config('agravion.updates.enabled'),
                'installedVersion' => (string) config('agravion.version'),
                'installedSha' => null,
                'installedAt' => null,
                'repo' => config('agravion.github.owner').'/'.config('agravion.github.repo'),
                'branch' => (string) config('agravion.github.branch'),
                'remoteSha' => null,
                'remoteMessage' => null,
                'remoteHtmlUrl' => null,
                'updateAvailable' => false,
                'checkedAt' => gmdate('c'),
                'error' => $e->getMessage(),
            ]);
        }
    }

    public function schedule(Request $request): JsonResponse
    {
        if (! $this->isAdmin($request)) {
            return response()->json(['message' => 'Forbidden.'], 403);
        }

        return response()->json(InstanceSchedule::status());
    }

    public function log(Request $request, GithubUpdateService $updates): JsonResponse
    {
        if (! $this->isAdmin($request)) {
            return response()->json(['message' => 'Forbidden.'], 403);
        }

        $lines = $updates->readUpdateLog(120);

        return response()->json([
            'lines' => $lines,
            'path' => 'storage/logs/agravion-update.log',
        ]);
    }

    public function apply(Request $request, GithubUpdateService $updates): JsonResponse
    {
        if (! $this->isAdmin($request)) {
            return response()->json(['message' => 'Forbidden.'], 403);
        }

        if (! config('agravion.updates.enabled')) {
            return response()->json(['ok' => false, 'error' => 'Updates are disabled.'], 403);
        }

        if (! $request->boolean('confirm')) {
            return response()->json([
                'ok' => false,
                'error' => 'Send confirm=true to apply an update from GitHub.',
            ], 422);
        }

        try {
            $result = $updates->apply(
                $request->string('sha')->toString() ?: null,
                $request->boolean('force'),
            );

            return response()->json($result);
        } catch (Throwable $e) {
            $parts = [];
            $current = $e;
            $guard = 0;
            while ($current !== null && $guard < 5) {
                $message = trim($current->getMessage());
                if ($message !== '' && ! in_array($message, $parts, true)) {
                    $parts[] = $message;
                }
                $current = $current->getPrevious();
                $guard++;
            }

            return response()->json([
                'ok' => false,
                'error' => $parts !== [] ? implode(' — ', $parts) : $e->getMessage(),
            ], 500);
        }
    }

    private function isAdmin(Request $request): bool
    {
        $user = $request->user();
        if (! $user) {
            return false;
        }

        $role = (string) ($user->global_role ?? 'admin');

        return $role === 'admin' || $role === 'realm_admin';
    }
}
