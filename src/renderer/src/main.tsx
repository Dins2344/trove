import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Settings } from './Settings'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

// One bundle serves both windows; the hash picks the view. The body attribute
// drives the styling difference -- the overlay paints on a transparent window,
// settings is an ordinary opaque one.
const isSettings = window.location.hash.startsWith('#/settings')
document.body.dataset.view = isSettings ? 'settings' : 'overlay'

createRoot(container).render(
  <StrictMode>{isSettings ? <Settings /> : <App />}</StrictMode>
)
