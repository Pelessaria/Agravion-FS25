import { useState, type FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { Navigate, useNavigate } from "react-router-dom"
import { LoaderCircle } from "lucide-react"
import { BrandLockup } from "../components/ui"
import { i18n } from "../i18n"
import { useStore } from "../store"
import { isLoginId } from "../validate"

function chooseLocale(lng: "de" | "en") {
  void i18n.changeLanguage(lng)
  localStorage.setItem("fs25.locale", lng)
  document.documentElement.lang = lng
}

export function LoginPage() {
  const { t, i18n: current } = useTranslation()
  const navigate = useNavigate()
  const { sessionUserId, signIn, liveMode, ready } = useStore()
  const [login, setLogin] = useState("")
  const [password, setPassword] = useState("")
  const [loginError, setLoginError] = useState("")
  const [passwordError, setPasswordError] = useState("")
  const [formError, setFormError] = useState("")
  const [pending, setPending] = useState(false)

  if (!ready) {
    return (
      <div className="login">
        <section className="login-panel" style={{ display: "grid", placeItems: "center" }}>
          <LoaderCircle className="icon spin" aria-label={t("login.submitting")} />
        </section>
      </div>
    )
  }

  if (sessionUserId) return <Navigate to="/" replace />

  async function submit(event: FormEvent) {
    event.preventDefault()
    const nextLogin = isLoginId(login) ? "" : t("login.loginInvalid")
    const nextPassword = password.length >= 8 ? "" : t("login.passwordShort")
    setLoginError(nextLogin)
    setPasswordError(nextPassword)
    setFormError("")
    if (nextLogin || nextPassword) return
    setPending(true)
    try {
      const result = await signIn(login.trim(), password)
      if (result === "failed") {
        setFormError(t("login.failed"))
        return
      }
      navigate("/")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="login">
      <aside className="login-aside">
        <div>
          <BrandLockup size="login" />
          <p className="hint">{t("login.kicker")}</p>
          <p className="lead">{t("login.lead")}</p>
        </div>
        {!liveMode ? <p className="hint">{t("demoBanner")}</p> : null}
      </aside>
      <section className="login-panel">
        <form className="login-card" onSubmit={(event) => void submit(event)} noValidate>
          <div className="login-tools">
            <div className="lang" role="group" aria-label={t("language")}>
              <button type="button" aria-pressed={current.language !== "en"} aria-label={t("german")} onClick={() => chooseLocale("de")}>
                DE
              </button>
              <button type="button" aria-pressed={current.language === "en"} aria-label={t("english")} onClick={() => chooseLocale("en")}>
                EN
              </button>
            </div>
          </div>
          <h2>{t("login.title")}</h2>
          <div className="stack">
            {formError ? (
              <p className="form-error" role="alert">
                {formError}
              </p>
            ) : null}
            <label className="field">
              <span>{t("login.login")}</span>
              <input
                type="text"
                autoComplete="username"
                inputMode="text"
                spellCheck={false}
                value={login}
                aria-invalid={loginError ? true : undefined}
                onChange={(event) => setLogin(event.target.value)}
              />
              {loginError ? <span className="field-error">{loginError}</span> : null}
            </label>
            <label className="field">
              <span>{t("login.password")}</span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                aria-invalid={passwordError ? true : undefined}
                onChange={(event) => setPassword(event.target.value)}
              />
              {passwordError ? (
                <span className="field-error">{passwordError}</span>
              ) : !liveMode ? (
                <span className="hint">{t("login.hint")}</span>
              ) : null}
            </label>
            <button className="btn btn-primary" type="submit" disabled={pending}>
              {pending ? <LoaderCircle className="icon spin" /> : null}
              {pending ? t("login.submitting") : t("login.submit")}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
