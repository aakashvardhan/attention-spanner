/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base64 DER public key pinning the extension id (Google Calendar OAuth) */
  readonly VITE_CRX_PUBLIC_KEY?: string;
  /** "Chrome Extension" OAuth client id for the Google Calendar API */
  readonly VITE_GCAL_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
