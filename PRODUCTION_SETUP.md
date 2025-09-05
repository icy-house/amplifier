# Production Setup for AmpleMusic

## Certificate Hashes for Firebase Console

### Debug Certificate (Development)
- **SHA-1**: `9C:AC:59:7A:54:B2:71:F1:02:12:E3:10:DD:FC:31:C4:74:B0:57:5F`
- **SHA-256**: `D8:B8:29:1B:37:5E:FD:1E:C4:BC:1B:13:F7:A5:2A:4F:CE:88:B9:0B:FA:1E:D4:30:CD:13:D7:3B:34:7D:C1:03`

### Release Certificate (Production)
- **SHA-1**: `3E:24:C1:EC:04:79:D9:FC:81:35:C3:D9:FD:94:6A:76:23:7D:45:37`
- **SHA-256**: `2D:43:90:F6:5C:5A:29:10:06:17:61:E3:E7:C6:3F:ED:D5:8F:66:44:9B:3E:C5:CF:DA:3C:9A:08:9A:52:09:93`

## Firebase Console Configuration

### 1. Add Certificate Hashes
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select project: `amplifier-backend`
3. Go to **Project Settings** → **Your apps** → **music.ample**
4. Click **Add fingerprint** for both:
   - Debug SHA-1: `9C:AC:59:7A:54:B2:71:F1:02:12:E3:10:DD:FC:31:C4:74:B0:57:5F`
   - Release SHA-1: `3E:24:C1:EC:04:79:D9:FC:81:35:C3:D9:FD:94:6A:76:23:7D:45:37`

### 2. Configure Apple Sign-In
1. Go to **Authentication** → **Sign-in method**
2. Click on **Apple** provider
3. Enable it and configure:
   - **Service ID**: `A39UD833JS.house.icy.amplemusic.service`
   - **Apple Team ID**: `A39UD833JS`
   - **Key ID**: Your Apple Music API Key ID
   - **Private Key**: Upload your `.p8` private key file

### 3. Download Updated Configuration
1. After adding certificate hashes, download updated `google-services.json`
2. Replace the file in `AmpleMusic/automotive/`

## Keystore Information

### Release Keystore Details
- **File**: `amplemusic-release-key.keystore`
- **Alias**: `amplemusic-key-alias`
- **Store Password**: `amplemusic2024`
- **Key Password**: `amplemusic2024`
- **Valid Until**: January 3, 2053

### Security Notes
- Keep the keystore file secure
- Store passwords in a secure location
- Consider using environment variables for passwords in CI/CD

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

## Apple Developer Configuration

### Service ID
- **Identifier**: `A39UD833JS.house.icy.amplemusic.service`
- **Type**: Sign In with Apple
- **Primary App ID**: Your main app's App ID
- **Domains**: `amplifier-backend.firebaseapp.com`
- **Return URLs**: Firebase will provide this after Apple Sign-In is configured

## Testing Production Build

1. **Build release APK**:
   ```bash
   ./gradlew assembleRelease
   ```

2. **Install on device**:
   ```bash
   adb install automotive/build/outputs/apk/release/automotive-release.apk
   ```

3. **Test Apple Sign-In** with production certificate

## Troubleshooting

### Common Issues
1. **"Site Not Found" error**: Ensure Apple Sign-In is properly configured in Firebase
2. **Authentication fails**: Verify certificate hashes are added to Firebase Console
3. **QR code issues**: Check that OAuth client is properly configured

### Verification Steps
1. Verify both debug and release hashes are in Firebase Console
2. Confirm Apple Sign-In provider is enabled
3. Test with both debug and release builds
4. Check Firebase logs for authentication errors
