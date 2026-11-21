# Production Setup for AmpleMusic

Production Firebase / Amplifer project: **`amplemusic-prod`**.

Hosting: https://ample.icy.house (custom domain; also `https://amplemusic-prod.web.app`)  
Firebase `authDomain` (SDK): `ample.icy.house`

## Certificate Hashes for Firebase Console

### Debug Certificate (Development)
- **SHA-1**: `9C:AC:59:7A:54:B2:71:F1:02:12:E3:10:DD:FC:31:C4:74:B0:57:5F`
- **SHA-256**: `D8:B8:29:1B:37:5E:FD:1E:C4:BC:1B:13:F7:A5:2A:4F:CE:88:B9:0B:FA:1E:D4:30:CD:13:D7:3B:34:7D:C1:03`

### Release Certificate (Production)
- **SHA-1**: `3E:24:C1:EC:04:79:D9:FC:81:35:C3:D9:FD:94:6A:76:23:7D:45:37`
- **SHA-256**: `2D:43:90:F6:5C:5A:29:10:06:17:61:E3:E7:C6:3F:ED:D5:8F:66:44:9B:3E:C5:CF:DA:3C:9A:08:9A:52:09:93`

## Firebase Console Configuration

### 1. Add Certificate Hashes (Android app)
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select project: `amplemusic-prod`
3. Go to **Project Settings** → **Your apps** → Android app (`music.ample`) when present
4. Click **Add fingerprint** for both debug and release SHA-1 values above

### 2. Sign in with Apple (Firebase Auth) — not MusicKit

SIWA and MusicKit use **different** Apple keys. Do not paste the MusicKit-only `.p8` into the Apple Auth provider.

| Purpose | Key ID | Where it lives |
|---------|--------|----------------|
| Sign in with Apple (Firebase Auth) | `RU5TXX2DP2` | Firebase Auth → Apple provider (Team ID + Key ID + `.p8`) |
| Apple Music / MusicKit developer JWT | `U2RCA774DG` | Secret Manager `APPLE_MUSIC_PRIVATE_KEY` + params |

Console steps (if redoing by hand):

1. **Authentication** → **Sign-in method** → **Apple**
2. Enable and set:
   - **Services ID**: `house.icy.amplemusic.service`
   - **Apple Team ID**: `A39UD833JS`
   - **Key ID**: `RU5TXX2DP2` (SIWA-capable key)
   - **Private Key**: contents of `AuthKey_RU5TXX2DP2.p8` only
3. Authorized domains should include `amplemusic-prod.firebaseapp.com`, `amplemusic-prod.web.app`, and `ample.icy.house`

### 3. Apple Developer — Services ID

In [Apple Developer](https://developer.apple.com/account/resources/identifiers/list/serviceId) → Services ID `house.icy.amplemusic.service` → Sign in with Apple → Configure:

- **Domains and Subdomains**: `ample.icy.house` (keep `amplemusic-prod.firebaseapp.com` if needed)
- **Return URLs**: `https://ample.icy.house/__/auth/handler`

`auth.html` sets Firebase `authDomain` to `ample.icy.house` so `signInWithRedirect` stays same-origin / same-tab.

Remove legacy `amplifier-backend.firebaseapp.com` entries after cutover.

### 4. Custom domain (`ample.icy.house`)

Firebase Hosting custom domain on site `amplemusic-prod`. At Squarespace DNS for `icy.house`:

| Type | Host | Value |
|------|------|-------|
| CNAME | `ample` | `amplemusic-prod.web.app` |
| TXT | `_acme-challenge.ample` | (value from Firebase Hosting cert verification; rotates) |

SIWA return URL: `https://ample.icy.house/__/auth/handler`. Auth authorized domains include `ample.icy.house`.

### 5. Download Updated Configuration
1. After adding certificate hashes, download updated `google-services.json`
2. Replace the file in the AmpleMusic automotive app module

## Release keystore

Store the release keystore and its passwords in a password manager / CI secrets — **never** in this repo. See issue #5 if credentials were previously documented here; rotate if they were exposed.

- **File** (local only): `amplemusic-release-key.keystore`
- **Alias**: `amplemusic-key-alias`

## Build Commands

### Debug Build
```bash
./gradlew assembleDebug
```

### Release Build
```bash
./gradlew assembleRelease
```

### Signing Report
```bash
./gradlew signingReport
```

## Testing Production Build

1. **Build release APK**:
   ```bash
   ./gradlew assembleRelease
   ```

2. **Install on device**:
   ```bash
   adb install automotive/build/outputs/apk/release/automotive-release.apk
   ```

3. **Test** phone QR flow against `https://ample.icy.house/auth.html`

## Troubleshooting

### Common Issues
1. **SIWA popup / redirect errors**: Confirm Services ID domains/return URL match `ample.icy.house` and `authDomain` is `ample.icy.house`
2. **Wrong key**: MusicKit key `U2RCA774DG` will not configure SIWA; use `RU5TXX2DP2`
3. **QR / Functions failures**: Cloud Functions must be deployed to `amplemusic-prod` (separate from SIWA enablement)

### Verification Steps
1. Firebase Auth → Apple provider enabled on `amplemusic-prod`
2. `auth.html` loads from `ample.icy.house` (or `amplemusic-prod.web.app`) with that project’s web config
3. Sign in with Apple completes in the browser
