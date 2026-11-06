import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { applyAccentPreference } from "./accent-theme"
import { App } from "./App"
import { StoreProvider } from "./store"
import "./i18n"
import "./styles.css"

applyAccentPreference()

const root = document.getElementById("root")
if (!root) throw new Error("Root missing")

createRoot(root).render(
  <StrictMode>
    <StoreProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StoreProvider>
  </StrictMode>,
)
