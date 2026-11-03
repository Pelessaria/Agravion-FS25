<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('workspaces', function (Blueprint $table) {
            $table->string('console_base_url')->nullable();
            $table->string('console_username')->nullable();
            $table->text('console_password_encrypted')->nullable();
        });

        Schema::create('module_grants', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->foreignId('workspace_id')->constrained()->cascadeOnDelete();
            $table->string('module_id', 40);
            $table->string('access', 10);
            $table->timestamps();
            $table->unique(['user_id', 'workspace_id', 'module_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('module_grants');
        Schema::table('workspaces', function (Blueprint $table) {
            $table->dropColumn(['console_base_url', 'console_username', 'console_password_encrypted']);
        });
    }
};
