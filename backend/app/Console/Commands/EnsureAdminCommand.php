<?php

namespace App\Console\Commands;

use App\Models\User;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;

class EnsureAdminCommand extends Command
{
    protected $signature = 'agravion:admin
        {--email= : Admin email (default: admin@agravion.local)}
        {--username= : Admin username (default: from email local-part)}
        {--password= : Admin password (generated if omitted)}
        {--name= : Display name (default: Admin)}';

    protected $description = 'Create or reset the global Agravion admin login.';

    public function handle(): int
    {
        $email = strtolower(trim((string) ($this->option('email') ?: 'admin@agravion.local')));
        $name = trim((string) ($this->option('name') ?: 'Admin'));
        $password = (string) ($this->option('password') ?: '');
        $generated = false;

        if ($password === '') {
            $password = Str::password(16);
            $generated = true;
        }

        if (! filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $this->error('Invalid email: '.$email);

            return self::FAILURE;
        }

        if (strlen($password) < 8) {
            $this->error('Password must be at least 8 characters.');

            return self::FAILURE;
        }

        $username = $this->normalizeUsername(
            (string) ($this->option('username') ?: Str::before($email, '@'))
        );
        if ($username === null) {
            $this->error('Invalid username. Use 2–64 chars: letters, digits, . _ -');

            return self::FAILURE;
        }

        $payload = [
            'name' => $name !== '' ? $name : 'Admin',
            'email' => $email,
            'password' => $password,
            'global_role' => 'admin',
        ];
        if (Schema::hasColumn('users', 'username')) {
            $taken = User::query()
                ->whereRaw('LOWER(username) = ?', [mb_strtolower($username, 'UTF-8')])
                ->where('email', '!=', $email)
                ->exists();
            if ($taken) {
                $this->error("Username already taken: {$username}");

                return self::FAILURE;
            }
            $payload['username'] = $username;
        }

        $user = User::query()->where('email', $email)->first();
        if ($user) {
            $user->forceFill($payload)->save();
            $this->info("Updated admin: {$email}");
        } else {
            User::query()->create($payload);
            $this->info("Created admin: {$email}");
        }

        $this->line('Email:    '.$email);
        if (isset($payload['username'])) {
            $this->line('Username: '.$payload['username']);
        }
        if ($generated) {
            $this->warn('Password: '.$password);
            $this->warn('Store this password now — it will not be shown again.');
        } else {
            $this->line('Password: (as provided)');
        }

        return self::SUCCESS;
    }

    private function normalizeUsername(string $raw): ?string
    {
        $username = strtolower(trim($raw));
        if (! preg_match('/^[a-z0-9._-]{2,64}$/', $username)) {
            return null;
        }

        return $username;
    }
}
