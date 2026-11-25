import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { AuthProvider } from './lib/auth.jsx'
import './index.css'
import './motion.css'

// Set BEFORE React renders (module scope runs before the first paint), so
// motion.css reveal rules can rely on it with no flash of hidden content.
// If JS never runs, the class is absent and everything stays visible.
document.documentElement.classList.add('has-js')

// Register the service worker that DISPLAYS push notifications (public/sw.js).
// Registering is silent and never prompts — subscription only happens from an
// explicit tap in the app (src/lib/push.js → NotificationBridge). Failure is
// non-fatal: the app works exactly as before without a service worker.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {})
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
)
