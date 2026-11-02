<?php

use App\Http\Controllers\AuthController;
use App\Http\Controllers\SystemUpdateController;
use App\Http\Controllers\WorkspaceController;
use Illuminate\Support\Facades\Route;

Route::get('/csrf-cookie', function () {
    // Session + ValidateCsrfToken middleware set the XSRF-TOKEN cookie.
    return response()->noContent();
});

Route::post('/login', [AuthController::class, 'login']);

Route::middleware('auth:web')->group(function () {
    Route::get('/me', [AuthController::class, 'me']);
    Route::post('/logout', [AuthController::class, 'logout']);

    Route::get('/workspaces', [WorkspaceController::class, 'index']);
    Route::post('/workspaces', [WorkspaceController::class, 'store']);
    Route::get('/workspaces/{workspace}', [WorkspaceController::class, 'show']);
    Route::patch('/workspaces/{workspace}', [WorkspaceController::class, 'update']);
    Route::post('/workspaces/{workspace}/sync', [WorkspaceController::class, 'sync']);
    Route::get('/workspaces/{workspace}/vehicles', [WorkspaceController::class, 'vehicles']);
    Route::get('/workspaces/{workspace}/fields', [WorkspaceController::class, 'fields']);
    Route::get('/workspaces/{workspace}/connector/fruits/{fruitKey}', [WorkspaceController::class, 'fruitIcon']);
    Route::get('/workspaces/{workspace}/farms', [WorkspaceController::class, 'farms']);
    Route::get('/workspaces/{workspace}/map', [WorkspaceController::class, 'map']);
    Route::post('/workspaces/{workspace}/connector/icons/sync', [WorkspaceController::class, 'syncConnectorIcons']);
    Route::get('/workspaces/{workspace}/connector/icons/{modKey}', [WorkspaceController::class, 'connectorIcon']);
    Route::get('/system/connector/package', [WorkspaceController::class, 'connectorPackage']);
    Route::get('/system/connector/package/meta', [WorkspaceController::class, 'connectorPackageMeta']);
    Route::post('/workspaces/{workspace}/connector/deploy', [WorkspaceController::class, 'deployConnector']);
    Route::get('/workspaces/{workspace}/required-mods', [WorkspaceController::class, 'requiredMods']);
    Route::put('/workspaces/{workspace}/host-access', [WorkspaceController::class, 'updateHostAccess']);
    Route::post('/workspaces/{workspace}/host-access/probe', [WorkspaceController::class, 'probeHostAccess']);
    Route::delete('/workspaces/{workspace}/host-access', [WorkspaceController::class, 'deleteHostAccess']);
    Route::post('/workspaces/{workspace}/savegames/select', [WorkspaceController::class, 'selectSavegame']);

    Route::get('/system/update', [SystemUpdateController::class, 'status']);
    Route::get('/system/schedule', [SystemUpdateController::class, 'schedule']);
    Route::get('/system/update/log', [SystemUpdateController::class, 'log']);
    Route::post('/system/update', [SystemUpdateController::class, 'apply']);
});
