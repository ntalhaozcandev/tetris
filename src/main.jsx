import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Tetris from '../tetris.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Tetris />
  </StrictMode>,
)
