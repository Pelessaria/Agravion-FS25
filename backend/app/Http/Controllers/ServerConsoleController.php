<?php

namespace App\Http\Controllers;

use App\Models\ModuleGrant;
use App\Models\User;
use App\Models\Workspace;
use App\Services\Fs25\DedicatedServerConsole;
use App\Services\Fs25\ModuleGrantService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use RuntimeException;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

class ServerConsoleController extends Controller
{
    public function show(Request $request, string $workspace, DedicatedServerConsole $console, ModuleGrantService $grants): JsonResponse
    {
        $row = $this->workspace($workspace);
        $this->requireServer($request, $row, $grants, 'any');
        $payload = $console->cached($row);
        $caps = $grants->serverFlagsFor($request->user(), $row);
        if (! $caps['mods']) {
            $payload['mods'] = [];
        }
        if (! $caps['log']) {
            $payload['log'] = null;
        }
        if (! $caps['control']) {
            $payload['actions'] = [];
            $payload['settings'] = [];
        }

        return response()->json($payload);
    }

    public function saveLogin(Request $request, string $workspace, DedicatedServerConsole $console): JsonResponse
    {
        $this->requireAdmin($request);
        $row = $this->workspace($workspace);
        $data = $request->validate([
            'username' => ['required', 'string', 'max:190'],
            'password' => ['nullable', 'string', 'max:500'],
            'keepPassword' => ['sometimes', 'boolean'],
        ]);
        if (($data['keepPassword'] ?? false) !== true && trim((string) ($data['password'] ?? '')) === '') {
            throw ValidationException::withMessages([
                'password' => 'Passwort fehlt.',
            ]);
        }
        $feed = trim((string) $row->feed_base_url);
        try {
            $row->console_base_url = $feed !== '' ? DedicatedServerConsole::origin($feed) : null;
        } catch (RuntimeException $e) {
            throw ValidationException::withMessages([
                'baseUrl' => $e->getMessage(),
            ]);
        }
        $row->console_username = trim($data['username']);
        if (($data['keepPassword'] ?? false) !== true) {
            $row->setConsolePassword((string) $data['password']);
        }
        $row->save();
        try {
            $console->refresh($row);
        } catch (Throwable) {
            // The saved login is kept. The minute job retries the snapshot.
        }

        return response()->json([
            'ok' => true,
            'console' => $this->consoleInfo($row),
        ]);
    }

    public function action(Request $request, string $workspace, DedicatedServerConsole $console, ModuleGrantService $grants): JsonResponse
    {
        $row = $this->workspace($workspace);
        $this->requireServer($request, $row, $grants, 'control');
        $data = $request->validate([
            'action' => ['required', 'in:start,stop,restart'],
        ]);

        return $this->attempt(fn () => $console->run($row, $data['action']));
    }

    public function settings(Request $request, string $workspace, DedicatedServerConsole $console, ModuleGrantService $grants): JsonResponse
    {
        $row = $this->workspace($workspace);
        $this->requireServer($request, $row, $grants, 'control');
        $data = $request->validate([
            'values' => ['required', 'array'],
        ]);

        return $this->afterChange($row, $console, fn () => $console->saveSettings($row, $data['values']));
    }

    public function upload(Request $request, string $workspace, DedicatedServerConsole $console, ModuleGrantService $grants): JsonResponse
    {
        $row = $this->workspace($workspace);
        $this->requireServer($request, $row, $grants, 'control');
        $request->validate([
            'file' => ['required', 'file', 'max:81920'],
        ]);
        $file = $request->file('file');
        if ($file === null) {
            throw ValidationException::withMessages(['file' => 'Datei fehlt.']);
        }
        $bytes = file_get_contents($file->getRealPath());
        if ($bytes === false) {
            throw ValidationException::withMessages(['file' => 'Datei konnte nicht gelesen werden.']);
        }

        return $this->afterChange($row, $console, fn () => $console->upload($row, $file->getClientOriginalName(), $bytes));
    }

    public function download(Request $request, string $workspace, DedicatedServerConsole $console, ModuleGrantService $grants): Response
    {
        $row = $this->workspace($workspace);
        $this->requireServer($request, $row, $grants, 'mods');
        $request->session()->save();
        $name = (string) $request->query('name', '');
        try {
            $file = $console->download($row, $name);
        } catch (RuntimeException $e) {
            return response()->json(['error' => $e->getMessage()], 422);
        } catch (Throwable) {
            return response()->json(['error' => 'Die Mod konnte nicht geladen werden.'], 422);
        }

        return response($file['bytes'], 200, [
            'Content-Type' => 'application/zip',
            'Content-Disposition' => 'attachment; filename="'.$file['name'].'"',
        ]);
    }

    public function updateMod(Request $request, string $workspace, DedicatedServerConsole $console, ModuleGrantService $grants): JsonResponse
    {
        $row = $this->workspace($workspace);
        $this->requireServer($request, $row, $grants, 'control');
        $data = $request->validate([
            'name' => ['required', 'string', 'max:180'],
        ]);

        return $this->afterChange($row, $console, fn () => $console->updateMod($row, $data['name']));
    }

    public function deleteMods(Request $request, string $workspace, DedicatedServerConsole $console, ModuleGrantService $grants): JsonResponse
    {
        $row = $this->workspace($workspace);
        $this->requireServer($request, $row, $grants, 'control');
        $data = $request->validate([
            'names' => ['required', 'array', 'min:1', 'max:100'],
            'names.*' => ['required', 'string', 'max:180'],
        ]);

        return $this->afterChange($row, $console, fn () => $console->deleteMods($row, $data['names']));
    }

    public function active(Request $request, string $workspace, DedicatedServerConsole $console, ModuleGrantService $grants): JsonResponse
    {
        $row = $this->workspace($workspace);
        $this->requireServer($request, $row, $grants, 'control');
        $data = $request->validate([
            'name' => ['required', 'string', 'max:180'],
            'active' => ['required', 'boolean'],
        ]);

        return $this->afterChange($row, $console, fn () => $console->setActive($row, $data['name'], (bool) $data['active']));
    }

    public function access(Request $request, string $workspace): JsonResponse
    {
        $this->requireAdmin($request);
        $row = $this->workspace($workspace);
        $grants = ModuleGrant::query()
            ->where('workspace_id', $row->id)
            ->where('module_id', 'server')
            ->get()
            ->keyBy('user_id');
        $users = User::query()->orderBy('name')->orderBy('id')->get(['id', 'name', 'email', 'global_role']);

        return response()->json([
            'users' => $users->map(function (User $user) use ($grants): array {
                $grant = $grants->get($user->id);

                return [
                    'id' => (string) $user->id,
                    'name' => (string) ($user->name !== '' ? $user->name : $user->email),
                    'email' => (string) $user->email,
                    'admin' => ($user->global_role ?? 'admin') !== 'member',
                    'access' => $grant?->access,
                ];
            })->values(),
        ]);
    }

    public function saveAccess(Request $request, string $workspace): JsonResponse
    {
        $request->merge(['moduleId' => 'server']);

        return $this->saveModuleAccess($request, $workspace);
    }

    public function saveModuleAccess(Request $request, string $workspace): JsonResponse
    {
        $this->requireAdmin($request);
        $row = $this->workspace($workspace);
        $data = $request->validate([
            'userId' => ['required', 'integer'],
            'moduleId' => ['required', 'in:map,fields,equipment,animals,storage,finance,trade,farm,server'],
            'access' => ['required', 'string', 'max:40'],
        ]);
        $access = (string) $data['access'];
        if ($data['moduleId'] === 'server') {
            $access = ModuleGrantService::encodeServerFlags($access) ?? 'none';
        } elseif (! in_array($access, ['none', 'read', 'write'], true)) {
            throw ValidationException::withMessages(['access' => 'Unbekannte Berechtigung.']);
        }
        $user = User::query()->find($data['userId']);
        if ($user === null) {
            throw ValidationException::withMessages(['userId' => 'Benutzer nicht gefunden.']);
        }
        if ($access === 'none' || ($user->global_role ?? 'admin') !== 'member') {
            ModuleGrant::query()
                ->where('user_id', $user->id)
                ->where('workspace_id', $row->id)
                ->where('module_id', $data['moduleId'])
                ->delete();
        } else {
            ModuleGrant::query()->updateOrCreate(
                [
                    'user_id' => $user->id,
                    'workspace_id' => $row->id,
                    'module_id' => $data['moduleId'],
                ],
                ['access' => $access],
            );
        }

        return response()->json(['ok' => true]);
    }

    private function workspace(string $publicId): Workspace
    {
        $row = Workspace::query()->where('public_id', $publicId)->first();
        if ($row === null) {
            abort(404);
        }

        return $row;
    }

    private function requireAdmin(Request $request): void
    {
        $user = $request->user();
        if ($user === null || ($user->global_role ?? 'admin') === 'member') {
            abort(403, 'Kein Zugriff auf die Serververwaltung.');
        }
    }

    private function requireServer(Request $request, Workspace $workspace, ModuleGrantService $grants, string $cap): void
    {
        if (! $grants->serverAllows($request->user(), $workspace, $cap)) {
            abort(403, 'Kein Zugriff auf die Serververwaltung.');
        }
    }

    /**
     * @param  callable(): array<string, mixed>  $call
     */
    private function afterChange(Workspace $workspace, DedicatedServerConsole $console, callable $call): JsonResponse
    {
        $response = $this->attempt($call);
        if ($response->isSuccessful()) {
            try {
                $console->refresh($workspace);
            } catch (Throwable) {
                // The change itself succeeded. The minute job rewrites the cache.
            }
        }

        return $response;
    }

    /**
     * @param  callable(): array<string, mixed>  $call
     */
    private function attempt(callable $call): JsonResponse
    {
        try {
            return response()->json($call());
        } catch (RuntimeException $e) {
            return response()->json(['error' => $e->getMessage()], 422);
        } catch (Throwable) {
            return response()->json(['error' => 'Die Serveroberfläche ist nicht erreichbar.'], 422);
        }
    }

    /**
     * @return array{configured: bool, username: string, baseUrl: string, hasPassword: bool}
     */
    private function consoleInfo(Workspace $workspace): array
    {
        return [
            'configured' => $workspace->consoleConfigured(),
            'username' => (string) ($workspace->console_username ?? ''),
            'baseUrl' => DedicatedServerConsole::displayOrigin($workspace->feed_base_url ?: $workspace->console_base_url),
            'hasPassword' => filled($workspace->console_password_encrypted),
        ];
    }
}
