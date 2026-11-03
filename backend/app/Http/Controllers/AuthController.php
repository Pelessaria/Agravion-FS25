<?php

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Schema;
use Illuminate\Validation\ValidationException;

class AuthController extends Controller
{
    public function login(Request $request): JsonResponse
    {
        $data = $request->validate([
            // Prefer "login"; keep "email" for older clients.
            'login' => ['nullable', 'string', 'min:2', 'max:255'],
            'email' => ['nullable', 'string', 'min:2', 'max:255'],
            'password' => ['required', 'string'],
        ]);

        $login = trim((string) ($data['login'] ?? $data['email'] ?? ''));
        if ($login === '') {
            throw ValidationException::withMessages([
                'login' => ['Benutzername oder E-Mail erforderlich.'],
            ]);
        }

        $user = $this->findByLogin($login);
        if (! $user || ! Hash::check($data['password'], $user->password)) {
            throw ValidationException::withMessages([
                'login' => ['Anmeldung fehlgeschlagen.'],
            ]);
        }

        Auth::login($user, remember: true);
        $request->session()->regenerate();

        return response()->json([
            'user' => $this->serializeUser($user),
        ]);
    }

    public function logout(Request $request): JsonResponse
    {
        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->json(['ok' => true]);
    }

    public function index(Request $request): JsonResponse
    {
        $user = $request->user();
        if ($user === null || ($user->global_role ?? 'admin') === 'member') {
            abort(403, 'Kein Zugriff auf die Benutzerverwaltung.');
        }
        $users = User::query()->orderBy('name')->orderBy('id')->get();

        return response()->json([
            'users' => $users->map(fn (User $row): array => $this->serializeUser($row))->values(),
        ]);
    }

    public function me(Request $request): JsonResponse
    {
        $user = $request->user();
        if (! $user) {
            return response()->json(['message' => 'Unauthenticated.'], 401);
        }

        return response()->json([
            'user' => $this->serializeUser($user),
        ]);
    }

    private function findByLogin(string $login): ?User
    {
        $normalized = mb_strtolower($login, 'UTF-8');

        return User::query()
            ->where(function ($query) use ($normalized) {
                $query->whereRaw('LOWER(email) = ?', [$normalized]);
                if (Schema::hasColumn('users', 'username')) {
                    $query->orWhereRaw('LOWER(username) = ?', [$normalized]);
                }
            })
            ->first();
    }

    /**
     * @return array<string, mixed>
     */
    private function serializeUser(User $user): array
    {
        $name = trim((string) $user->name);
        $parts = preg_split('/\s+/', $name) ?: [];
        $first = $parts[0] ?? '';
        $last = trim(implode(' ', array_slice($parts, 1)));
        $role = ($user->global_role ?? 'admin') === 'member' ? 'member' : 'admin';
        $username = trim((string) ($user->username ?? ''));
        $alias = $username !== '' ? $username : ($first !== '' ? $first : (string) $user->email);

        return [
            'id' => (string) $user->id,
            'name' => $name !== '' ? $name : (string) $user->email,
            'username' => $username !== '' ? $username : null,
            'email' => (string) $user->email,
            'firstName' => $first,
            'lastName' => $last,
            'alias' => $alias,
            'notificationEmail' => (string) $user->email,
            'avatarDataUrl' => null,
            'twoFactorEnabled' => false,
            'globalRole' => $role,
            'active' => true,
            'memberships' => app(\App\Services\Fs25\ModuleGrantService::class)->membershipsFor($user),
            'groupIds' => [],
        ];
    }
}
