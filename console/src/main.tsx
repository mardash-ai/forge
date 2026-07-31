import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

/**
 * Fonts are BUNDLED, not fetched.
 *
 * These imports pull the woff2 files into the build so they are served from the same origin as the
 * app. Nothing here reaches fonts.googleapis.com — a console whose type stops rendering when the
 * network is degraded is broken at exactly the moment it is needed, and an outbound font request
 * from an ops surface is one more thing that can hang behind a missing Cloud NAT.
 *
 * Archivo carries prose and the interface; IBM Plex Mono carries every machine-side identifier.
 * The grotesque ships as one variable file; the mono as two weights. No 700 anywhere.
 */
import '@fontsource-variable/archivo/wght.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';

import './design/tokens.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
