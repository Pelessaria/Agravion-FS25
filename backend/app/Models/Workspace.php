<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Str;

class Workspace extends Model
{
    protected $fillable = [
        'public_id',
        'display_name',
        'number',
        'lifecycle',
        'link_state',
        'data_mode',
        'map_name',
        'game_version',
        'day_time_ms',
        'map_size',
        'players_online',
        'player_capacity',
        'connector_version',
        'last_seen_at',
        'last_sync_at',
        'status_note',
        'feed_base_url',
        'feed_code_encrypted',
        'console_base_url',
        'console_username',
        'console_password_encrypted',
    ];

    protected function casts(): array
    {
        return [
            'last_seen_at' => 'datetime',
            'last_sync_at' => 'datetime',
            'map_size' => 'integer',
            'day_time_ms' => 'integer',
            'players_online' => 'integer',
            'player_capacity' => 'integer',
            'number' => 'integer',
        ];
    }

    protected static function booted(): void
    {
        static::creating(function (Workspace $workspace) {
            if (empty($workspace->public_id)) {
                $workspace->public_id = (string) Str::uuid();
            }
        });
    }

    public function setFeedCode(?string $code): void
    {
        $this->feed_code_encrypted = $code === null || $code === ''
            ? null
            : Crypt::encryptString($code);
    }

    public function setConsolePassword(?string $password): void
    {
        $this->console_password_encrypted = $password === null || $password === ''
            ? null
            : Crypt::encryptString($password);
    }

    public function consolePassword(): ?string
    {
        if ($this->console_password_encrypted === null || $this->console_password_encrypted === '') {
            return null;
        }

        return Crypt::decryptString($this->console_password_encrypted);
    }

    public function consoleConfigured(): bool
    {
        return filled($this->console_username) && filled($this->console_password_encrypted);
    }

    public function feedCode(): ?string
    {
        if ($this->feed_code_encrypted === null || $this->feed_code_encrypted === '') {
            return null;
        }

        return Crypt::decryptString($this->feed_code_encrypted);
    }

    public function hostAccess(): HasOne
    {
        return $this->hasOne(HostAccess::class);
    }

    public function gameFarms(): HasMany
    {
        return $this->hasMany(GameFarm::class);
    }

    public function savegames(): HasMany
    {
        return $this->hasMany(WorkspaceSavegame::class);
    }

    public function activeSavegame(): ?WorkspaceSavegame
    {
        return $this->savegames()->where('is_active', true)->first();
    }
}
