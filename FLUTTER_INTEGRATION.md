# Notice Watch — Flutter Integration Guide

Backend: Fastify + Firebase + BullMQ  
Auth: Firebase Auth (anonymous + Google sign-in)  
Base URL: configure per environment via `--dart-define` or `.env`

---

## 1. Auth Strategy

### How it works

The app always uses Firebase Auth. Anonymous users get a real Firebase UID — no custom UUID needed.

```dart
// On first app open — call once
await FirebaseAuth.instance.signInAnonymously();

// On every API call — get fresh ID token
final token = await FirebaseAuth.instance.currentUser!.getIdToken();
```

All authenticated endpoints require:
```
Authorization: Bearer <firebase-id-token>
```

Tokens expire after 1 hour. Firebase SDK auto-refreshes. Always call `getIdToken()` fresh per request (it returns cached if still valid).

### Anonymous → Google login upgrade

```dart
final googleUser = await GoogleSignIn().signIn();
final googleAuth = await googleUser!.authentication;
final credential = GoogleAuthProvider.credential(
  accessToken: googleAuth.accessToken,
  idToken: googleAuth.idToken,
);

// Link — preserves same Firebase UID, all data stays
await FirebaseAuth.instance.currentUser!.linkWithCredential(credential);
```

If user already has a Google account (collision error `credential-already-in-use`):
- The anonymous account cannot be linked
- Prompt user: "This Google account already has data. Switch to it? Your anonymous trackers will be lost."
- If yes: `await FirebaseAuth.instance.signInWithCredential(credential)`

### Subscription / session restoration

On app open, after Firebase restores auth:
1. Call `GET /api/me` with ID token
2. Response gives full user state including subscription, tracker limits, ad slots
3. Firebase handles UID restoration across reinstalls (iOS: iCloud Keychain, Android: Google account)

Anonymous users who reinstall and have no Google account linked will lose their session. Warn them: *"Log in to back up your trackers."*

---

## 2. First Launch Flow

```
App opens
  ↓
FirebaseAuth.instance.currentUser == null?
  → signInAnonymously()
  ↓
POST /api/auth/register          ← create UserDoc if not exists
  ↓
GET /api/me                      ← load state, limits, subscription
  ↓
Show home screen
```

### POST /api/auth/register

**No auth required** (but send token if available — backend uses it to set UID)

```
POST /api/auth/register
Authorization: Bearer <token>
Content-Type: application/json

{}
```

Response `201` or `200` (idempotent):
```json
{
  "uid": "firebase-uid",
  "anonymous": true,
  "createdAt": "2026-06-27T..."
}
```

---

## 3. GET /api/me

```
GET /api/me
Authorization: Bearer <token>
```

Response:
```json
{
  "uid": "abc123",
  "anonymous": true,
  "subscribed": false,
  "subscribedUntil": null,
  "trackerCount": 2,
  "trackerLimit": 5,
  "activeAdSlots": 1,
  "adSlotsDetail": [
    { "expiresAt": "2026-07-12T..." }
  ]
}
```

`trackerLimit` already computed by backend:
- Free: 5 + activeAdSlots (capped at 10)
- Subscribed: 100

Use this to:
- Show/hide "Add Tracker" button (`trackerCount < trackerLimit`)
- Show subscription badge
- Show remaining ad slot days

---

## 4. Trackers

### Create tracker

**Requires auth.**

Anonymous users: `global` is always forced to `true` by backend regardless of what you send.
Logged-in users: can set `global: false` to keep notices private.

```
POST /api/trackers
Authorization: Bearer <token>
Content-Type: application/json

{
  "url": "https://example.com/notices",
  "prompt": "exam schedule announcements",
  "global": false,
  "integrityToken": "<play-integrity-token>"
}
```

**Play Integrity token** (get before calling this endpoint):
```dart
// Add dependency: google_play_integrity (or use play_integrity package)
final integrityManager = IntegrityManager();
final tokenResponse = await integrityManager.requestIntegrityToken(
  nonce: base64Encode(utf8.encode(url + uid)),
);
final integrityToken = tokenResponse.token;
```

Response `201`:
```json
{
  "id": "tracker-doc-id",
  "tracker": { ...TrackerDoc... }
}
```

Error responses:
- `400` invalid URL / prompt too short / integrity token invalid
- `403` tracker limit reached
- `402` subscription required (if premium-only feature)

**Show anonymous warning before creation:**
> "Since you're not logged in, this tracker and its notices will be visible to all users. Log in to keep them private."
> [Continue Anonymously] [Log In]

### List trackers

```
GET /api/trackers
Authorization: Bearer <token>
```

Response:
```json
{ "trackers": [ ...TrackerDoc[] ] }
```

### Toggle active / delete / manual scrape

```
PATCH  /api/trackers/:id          toggle active
DELETE /api/trackers/:id          soft delete
POST   /api/trackers/:id/scrape   trigger immediate check
```

All require auth. No body needed for toggle/scrape.

### Edit tracker

```
PUT /api/trackers/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "prompt": "updated prompt",
  "global": true
}
```

URL cannot be changed (changing URL = different source). If user wants different URL, delete and recreate.

---

## 5. Notices

### GET /api/notices — cross-tracker global feed

**No auth required for `mode=global`.**  
**Auth required for `mode=mine`.**

```
GET /api/notices?mode=mine&limit=20&startAfter=<cursor>
Authorization: Bearer <token>

GET /api/notices?mode=global&limit=20&startAfter=<cursor>
(no auth header needed)
```

Response:
```json
{
  "notices": [
    {
      "id": "...",
      "trackerId": "...",
      "title": "Exam Schedule Released",
      "summary": "...",
      "link": "https://...",
      "publishedDate": "2026-06-25",
      "createdAt": "...",
      "readAt": null
    }
  ],
  "pagination": {
    "hasMore": true,
    "nextCursor": "last-notice-id"
  }
}
```

### GET /api/notices/:trackerId — per-tracker notices

```
GET /api/notices/:trackerId?limit=20&startAfter=<cursor>
Authorization: Bearer <token>
```

Same response shape.

### Mark read

```
PATCH /api/notices/:noticeId/read
Authorization: Bearer <token>
```

### Mark all read for tracker

```
PATCH /api/notices/:trackerId/read-all
Authorization: Bearer <token>
```

---

## 6. Subscription (Google Play IAP)

### Flow

```dart
// 1. Show paywall, user taps subscribe
final products = await InAppPurchase.instance.queryProductDetails({'notice_watch_premium'});

// 2. Initiate purchase
await InAppPurchase.instance.buyNonConsumable(
  purchaseParam: PurchaseParam(productDetails: products.productDetails.first),
);

// 3. Listen to purchase stream
InAppPurchase.instance.purchaseStream.listen((purchases) async {
  for (final purchase in purchases) {
    if (purchase.status == PurchaseStatus.purchased) {
      // 4. Send to backend for verification
      await verifySubscription(
        purchaseToken: purchase.verificationData.serverVerificationData,
        productId: purchase.productID,
      );
      // 5. Deliver: complete purchase
      await InAppPurchase.instance.completePurchase(purchase);
      // 6. Refresh user state
      await refreshMe();
    }
  }
});
```

### POST /api/subscription/verify

```
POST /api/subscription/verify
Authorization: Bearer <token>
Content-Type: application/json

{
  "purchaseToken": "google-play-purchase-token",
  "productId": "notice_watch_premium"
}
```

Response `200`:
```json
{
  "subscribed": true,
  "subscribedUntil": "2027-06-27T..."
}
```

Backend verifies with Google Play Developer API, updates UserDoc. Call `GET /api/me` after to refresh UI.

### Subscription restoration on app open

```dart
// Restore purchases (handles reinstall / new device)
await InAppPurchase.instance.restorePurchases();
// This triggers purchaseStream — handle same as above
// Backend verify call is idempotent — safe to call again
```

---

## 7. Rewarded Ads (AdMob SSV)

### Flow

The app does NOT call your backend directly after ad. AdMob's servers call your backend via SSV callback. App just needs to poll for confirmation.

```dart
// 1. Set up rewarded ad with user ID in customData
RewardedAd.load(
  adUnitId: '<your-ad-unit-id>',
  request: AdRequest(),
  serverSideVerificationOptions: ServerSideVerificationOptions(
    userId: FirebaseAuth.instance.currentUser!.uid,
    customData: 'ad_slot_grant',  // optional context
  ),
  rewardedAdLoadCallback: RewardedAdLoadCallback(
    onAdLoaded: (ad) {
      // 2. Show ad
      ad.show(onUserEarnedReward: (ad, reward) async {
        // 3. Ad completed — AdMob will call your backend SSV endpoint
        // 4. Poll /api/me to confirm slot was granted (retry 3x with 2s delay)
        await Future.delayed(Duration(seconds: 2));
        await refreshMe();
      });
    },
    onAdFailedToLoad: (error) { /* handle */ },
  ),
);
```

### Backend SSV endpoint

AdMob calls this — you do not call it from Flutter:
```
GET /api/ad/admob-ssv?...
```

After AdMob calls it, your backend creates an AdSlotDoc for the user. The `GET /api/me` poll confirms it.

### Limits

- Each rewarded ad = 1 extra tracker slot for 15 days
- Max 5 extra slots via ads (total cap: 10 trackers without subscription)
- `activeAdSlots` in `/api/me` response shows current active count

---

## 8. Devices (Push Notifications)

Register FCM token after Firebase Messaging permission granted:

```dart
final fcmToken = await FirebaseMessaging.instance.getToken();

// Register
await http.post(
  Uri.parse('$baseUrl/api/devices'),
  headers: {'Authorization': 'Bearer $idToken', 'Content-Type': 'application/json'},
  body: jsonEncode({'fcmToken': fcmToken, 'platform': 'android'}),
);

// Refresh token listener
FirebaseMessaging.instance.onTokenRefresh.listen((newToken) async {
  // Re-register with new token
});
```

Notification payload from backend:
```json
{
  "data": {
    "trackerId": "...",
    "noticeId": "..."
  }
}
```

On notification tap: navigate to `NoticeDetailScreen(noticeId: ...)`.

---

## 9. Error Handling

| Status | Meaning | UI Action |
|--------|---------|-----------|
| `400` | Bad request | Show field error |
| `401` | Token expired | Re-fetch ID token, retry once |
| `402` | Subscription required | Show paywall |
| `403` | Tracker limit reached | Show upgrade prompt |
| `404` | Not found | Show empty state |
| `429` | Rate limited | Show "try again later" |
| `500` | Server error | Show generic error, log to Crashlytics |

---

## 10. Anonymous User UX Checklist

- [ ] Show banner: *"You're browsing anonymously. Log in to keep trackers private and restore them if you reinstall."*
- [ ] On "Add Tracker": show global sharing warning before API call
- [ ] Disable `global` toggle (lock to true) for anonymous users
- [ ] On tracker limit hit: show "Watch an ad for 15 more days" CTA + "Subscribe for unlimited" CTA
- [ ] After Google login link: refresh `GET /api/me` — UID stays the same, data persists

---

## 11. Environment Config

```dart
// via --dart-define
const baseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://localhost:5674');
const adUnitIdRewarded = String.fromEnvironment('ADMOB_REWARDED_ID');
```
