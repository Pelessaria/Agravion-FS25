import { Navigate, Route, Routes, useParams } from "react-router-dom"
import { AccessPage } from "./pages/access"
import { ControlPage } from "./pages/control"
import { CreatePage } from "./pages/create"
import { DashboardPage } from "./pages/dashboard"
import { FieldsPage } from "./pages/fields"
import { LoginPage } from "./pages/login"
import { ModulePage } from "./pages/module"
import { SettingsPage } from "./pages/settings"
import { VehicleDetailPage } from "./pages/vehicle-detail"
import { VehiclesPage } from "./pages/vehicles"
import { WorkspaceHomePage } from "./pages/workspace-home"
import { WorkspaceSettingsPage } from "./pages/workspace-settings"
import { Shell } from "./shell"
import { useStore } from "./store"

function RequireAuth() {
  const { sessionUserId, ready } = useStore()
  if (!ready) {
    return (
      <div className="app-boot" style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
        <span className="muted">…</span>
      </div>
    )
  }
  if (!sessionUserId) return <Navigate to="/login" replace />
  return <Shell />
}

function LegacyVehiclesRedirect() {
  const { id = "", vehicleId } = useParams()
  return <Navigate to={vehicleId ? `/w/${id}/equipment/${vehicleId}` : `/w/${id}/equipment`} replace />
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route index element={<DashboardPage />} />
        <Route path="instances" element={<ControlPage />} />
        <Route path="instances/new" element={<CreatePage />} />
        <Route path="access" element={<AccessPage />} />
        <Route path="access/groups" element={<AccessPage />} />
        <Route path="users" element={<Navigate to="/access" replace />} />
        <Route path="groups" element={<Navigate to="/access/groups" replace />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="w/:id" element={<WorkspaceHomePage />} />
        <Route path="w/:id/m/fields" element={<FieldsPage />} />
        <Route path="w/:id/equipment" element={<VehiclesPage />} />
        <Route path="w/:id/equipment/:vehicleId" element={<VehicleDetailPage />} />
        <Route path="w/:id/vehicles" element={<LegacyVehiclesRedirect />} />
        <Route path="w/:id/vehicles/:vehicleId" element={<LegacyVehiclesRedirect />} />
        <Route path="w/:id/settings" element={<WorkspaceSettingsPage />} />
        <Route path="w/:id/m/:moduleId" element={<ModulePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
