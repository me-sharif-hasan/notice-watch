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

If collision error `credential-already-in-use`:
- Prompt user: "This Google account already has data. Switch to it? Your anonymous trackers will be lost."
- If yes: `await FirebaseAuth.instance.signInWithCredential(credential)`

### Session restoration

Firebase SDK restores auth automatically across restarts and reinstalls (iOS: iCloud Keychain, Android: Google account backup). On app open:

1. Firebase restores UID automatically
2. Call `GET /api/me` → full user state including subscription, limits, coins
3. Show UI based on response

Anonymous users who reinstall without Google link will lose their session. Warn them: *"Log in to back up your trackers."*

---

## 2. First Launch Flow

```
App opens
  ↓
FirebaseAuth.instance.currentUser == null?
  → signInAnonymously()
  ↓
POST /api/auth/register          ← create UserDoc if not exists (idempotent)
  ↓
GET /api/me                      ← load state, limits, coins
  ↓
Show home screen
```

### POST /api/auth/register

```
POST /api/auth/register
Authorization: Bearer <token>
```

Response `201` (or `200` if already exists):
```json
{
  "user": {
    "uid": "firebase-uid",
    "anonymous": true,
    "subscribed": false,
    "coins": 0,
    "trackerCount": 0,
    "createdAt": "..."
  }
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
  "coins": 12,
  "trackerCount": 3,
  "trackerLimit": 5
}
```

`trackerLimit` is computed server-side: `subscribed ? 100 : 5`.
Coins extend tracker capacity: each extra tracker (beyond 5) costs 1 coin/day. Max 50 coins.

Use this to:
- Show/hide "Add Tracker" button (`trackerCount < trackerLimit`)
- Show coin balance and subscription status
- Gate premium UI

---

## 4. Trackers

### Create tracker

**Requires auth.**

Anonymous users: `global` is always forced to `true` by backend regardless of what you send.
Logged-in users: can set `global: false` to keep notices private.

Show anonymous warning before creation:
> *"Since you're not logged in, this tracker and its notices will be visible to all users. Log in to keep them private."*

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

**Play Integrity token:**
```dart
final tokenResponse = await PlayIntegrity.requestIntegrityToken(
  nonce: base64Encode(utf8.encode(url + uid)),
);
```

Response `201`:
```json
{ "id": "tracker-id", "tracker": { ...TrackerDoc } }
```

Error responses:
- `400` invalid URL / integrity token required
- `403` tracker limit reached → show coin/subscribe prompt
- `429` rate limited

**Tracker limit hit UI flow:**
1. Show: "You've reached your tracker limit"
2. CTA 1: "Watch an ad to earn coins" (see §7)
3. CTA 2: "Subscribe for 100 trackers" (see §6)

### Other tracker endpoints

```
GET    /api/trackers              list user's active trackers
GET    /api/trackers/:id          single tracker
PUT    /api/trackers/:id          edit prompt/global (URL not editable — delete+recreate)
DELETE /api/trackers/:id          soft delete (frees tracker slot)
PATCH  /api/trackers/:id          toggle active/inactive (also adjusts slot count)
POST   /api/trackers/:id/scrape   manual check now (429 if < 30min since last)
```

Manual scrape UI: show countdown timer after trigger. Disable button for 30 minutes.

---

## 5. Notices

### GET /api/notices — cross-tracker feed

**`mode=global`: no auth required.**
**`mode=mine`: auth required.**

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
      "global": true,
      "publishedDate": "2026-06-25",
      "createdAt": "...",
      "readAt": null
    }
  ],
  "pagination": { "hasMore": true, "nextCursor": "last-notice-id" }
}
```

### GET /api/notices/single/:noticeId — deep link from notification

```
GET /api/notices/single/:noticeId
Authorization: Bearer <token>
```

Use this when user taps FCM notification to navigate directly to a notice.

### Per-tracker notices

```
GET /api/notices/:trackerId?limit=20&startAfter=<cursor>
Authorization: Bearer <token>
```

### Mark read

```
PATCH /api/notices/:noticeId/read        mark single notice read
PATCH /api/notices/:trackerId/read-all   mark all notices in tracker read
Authorization: Bearer <token>
```

---

## 6. Subscription (Google Play IAP)

Subscription status auto-updates server-side via Google Play RTDN webhook. Flutter team does NOT need to implement any webhook — just call `/api/subscription/verify` after purchase and the server handles the rest (renewals, cancellations, expiry).

### Purchase flow

```dart
// 1. Query products
final products = await InAppPurchase.instance.queryProductDetails({'notice_watch_premium'});

// 2. Initiate purchase
await InAppPurchase.instance.buyNonConsumable(
  purchaseParam: PurchaseParam(productDetails: products.productDetails.first),
);

// 3. Listen to purchase stream
InAppPurchase.instance.purchaseStream.listen((purchases) async {
  for (final purchase in purchases) {
    if (purchase.status == PurchaseStatus.purchased) {
      // 4. Verify with backend
      await http.post(
        Uri.parse('$baseUrl/api/subscription/verify'),
        headers: {'Authorization': 'Bearer $idToken', 'Content-Type': 'application/json'},
        body: jsonEncode({
          'purchaseToken': purchase.verificationData.serverVerificationData,
          'productId': purchase.productID,
        }),
      );
      // 5. Complete purchase
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

{ "purchaseToken": "...", "productId": "notice_watch_premium" }
```

Response `200`: `{ "subscribed": true }`

### Subscription restoration on app open

```dart
// Restores purchases on new device / reinstall
await InAppPurchase.instance.restorePurchases();
// purchaseStream fires → call /api/subscription/verify again (idempotent)
```

---

## 7. Coins & Rewarded Ads (AdMob)

### How coins work

- Each extra tracker beyond 5 costs **1 coin per day**
- Watch a rewarded ad → earn coins (amount set by ad unit, max 50 coins total)
- Coins run out → extra trackers are disabled automatically (server-side daily sweep)
- Re-earn coins → extra trackers can be re-enabled by toggling them back on

### Rewarded ad flow

The app does NOT call the backend directly after the ad. AdMob's servers call your backend via SSV. App polls `/api/me` to confirm.

```dart
// 1. Load rewarded ad with Firebase UID in userId
RewardedAd.load(
  adUnitId: const String.fromEnvironment('ADMOB_REWARDED_ID'),
  request: const AdRequest(),
  serverSideVerificationOptions: ServerSideVerificationOptions(
    userId: FirebaseAuth.instance.currentUser!.uid,
    customData: 'coin_reward',
  ),
  rewardedAdLoadCallback: RewardedAdLoadCallback(
    onAdLoaded: (ad) {
      ad.show(onUserEarnedReward: (ad, reward) async {
        // 2. Ad completed — AdMob will call your backend SSV endpoint automatically
        // 3. Wait briefly then poll /api/me to confirm coins were granted
        await Future.delayed(const Duration(seconds: 3));
        await refreshMe();
        // Show updated coin balance to user
      });
    },
    onAdFailedToLoad: (error) { /* handle */ },
  ),
);
```

### Coin display

Show coin balance prominently when user has extra trackers. Example UI:
- "12 coins remaining (~12 days for 1 extra tracker)"
- Progress bar from 0 to 50
- "Watch ad to earn more" button

---

## 8. Devices (Push Notifications)

Register FCM token after permission is granted. Backend upserts by token — no duplicates.

```dart
final fcmToken = await FirebaseMessaging.instance.getToken();

await http.post(
  Uri.parse('$baseUrl/api/devices'),
  headers: {'Authorization': 'Bearer $idToken', 'Content-Type': 'application/json'},
  body: jsonEncode({'fcmToken': fcmToken, 'platform': 'android'}), // or 'ios'
);

// Handle token refresh
FirebaseMessaging.instance.onTokenRefresh.listen((newToken) async {
  // Re-register — backend upserts by token value, no duplicate created
  await registerDevice(newToken);
});
```

### FCM Notification Payload Types

All notifications include a `data` map. Route by `data['type']`:

| type | When sent | Data fields |
|------|-----------|-------------|
| `new_notice` | New notice found | `trackerId`, `noticeId` |
| `coins_earned` | AdMob SSV processed | `coins` (earned), `totalCoins` |
| `coins_low` | Balance ≤ 3 coins | `coins` (remaining) |
| `tracker_disabled` | Coins ran out, trackers disabled | _(none)_ |

```dart
FirebaseMessaging.onMessage.listen((message) {
  final type = message.data['type'];
  switch (type) {
    case 'new_notice':
      final noticeId = message.data['noticeId'];
      // Navigate to NoticeDetailScreen or show in-app banner
      break;
    case 'tracker_disabled':
      // Show dialog: "Watch an ad to re-enable your trackers"
      break;
    case 'coins_low':
      // Show snackbar with "Top up" CTA
      break;
    case 'coins_earned':
      // Show snackbar: "You earned X coins!"
      break;
  }
});

// Notification tap (app in background/terminated)
FirebaseMessaging.onMessageOpenedApp.listen((message) {
  final type = message.data['type'];
  if (type == 'new_notice') {
    final noticeId = message.data['noticeId'];
    navigateTo(NoticeDetailScreen(noticeId: noticeId));
  }
});
```

---

## 9. Error Handling

| Status | Meaning | UI Action |
|--------|---------|-----------|
| `400` | Bad request | Show field error |
| `401` | Token expired | Re-fetch ID token via `getIdToken(force: true)`, retry once |
| `402` | Subscription not active | Show paywall |
| `403` | Tracker limit reached | Show coin/subscribe prompt |
| `404` | Not found | Show empty state |
| `429` | Rate limited / cooldown | Show "try again later" or countdown timer |
| `500` | Server error | Generic error, log to Crashlytics |

---

## 10. Anonymous User UX Checklist

- [ ] Show persistent banner: *"You're browsing anonymously. Log in to keep trackers private and restore them if you reinstall."*
- [ ] On "Add Tracker": show global sharing warning modal before API call
- [ ] Disable and lock `global` toggle to true for anonymous users
- [ ] On tracker limit hit: show "Watch an ad to earn coins" + "Subscribe for 100 trackers" CTAs
- [ ] After Google login link: call `GET /api/me` — UID stays the same, all data persists

---

## 11. Environment Config

```dart
// via --dart-define
const baseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://localhost:5674');
const adUnitIdRewarded = String.fromEnvironment('ADMOB_REWARDED_ID');
```

---

## 12. Full API Reference

```
Auth
  POST /api/auth/register           Create/get UserDoc (idempotent)
  GET  /api/me                      User profile, limits, coins

Trackers
  POST   /api/trackers              Create tracker
  GET    /api/trackers              List user's trackers
  GET    /api/trackers/:id          Get single tracker
  PUT    /api/trackers/:id          Edit prompt / global flag
  DELETE /api/trackers/:id          Delete tracker (frees slot)
  PATCH  /api/trackers/:id          Toggle active/inactive
  POST   /api/trackers/:id/scrape   Manual check now (30min cooldown)

Notices
  GET    /api/notices                Cross-tracker feed (?mode=mine|global)
  GET    /api/notices/single/:id     Single notice by ID (for deep link)
  GET    /api/notices/:trackerId     Per-tracker notices (paginated)
  PATCH  /api/notices/:id/read       Mark single notice read
  PATCH  /api/notices/:trackerId/read-all  Mark all read for tracker

Devices
  GET    /api/devices               List user's registered devices
  POST   /api/devices               Register FCM token
  DELETE /api/devices/:id           Unregister device

Subscription
  POST   /api/subscription/verify   Verify Google Play purchase

Ads
  GET    /api/ad/admob-ssv          AdMob SSV callback (called by AdMob, not app)
```
