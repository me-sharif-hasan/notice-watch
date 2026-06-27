# Notice Watch — Flutter Integration Guide

Backend: Fastify + Firebase + BullMQ  
Auth: Firebase Auth (anonymous + email/Google sign-in)  
Base URL: `https://notice-watch.iishanto.com`  
Package: `com.iishanto.noticewatch`

---

## Auth Basics

Every protected endpoint requires:
```
Authorization: Bearer <firebase-id-token>
```

Get token:
```dart
final token = await FirebaseAuth.instance.currentUser!.getIdToken();
```

Tokens expire in 1 hour. Firebase SDK auto-refreshes. Call `getIdToken()` fresh per request.

On `401` response: call `getIdToken(force: true)` and retry once.

---

## Screen: Splash / App Init

**Goal:** establish identity, load user state, register push token.

```
App opens
  ↓
currentUser == null?
  → signInAnonymously()
  ↓
POST /api/auth/register   ← idempotent, creates UserDoc if missing
  ↓
GET /api/me               ← coins, trackerCount, trackerLimit, subscription
  ↓
POST /api/devices         ← register FCM token
  ↓
Navigate to Home
```

### POST /api/auth/register

```
POST /api/auth/register
Authorization: Bearer <token>
Content-Type: application/json
Body: {}
```

Response `201`:
```json
{
  "user": {
    "uid": "VgX7tBRtESYrFGC7vseSMYY9SBm1",
    "email": "me@example.com",
    "anonymous": false,
    "subscribed": false,
    "subscribedUntil": null,
    "coins": 0,
    "trackerCount": 0,
    "createdAt": { "_seconds": 1782562920, "_nanoseconds": 0 }
  }
}
```

Always `201` — idempotent, safe to call on every launch.

### GET /api/me

```
GET /api/me
Authorization: Bearer <token>
```

Response `200`:
```json
{
  "uid": "VgX7tBRtESYrFGC7vseSMYY9SBm1",
  "anonymous": false,
  "subscribed": false,
  "subscribedUntil": null,
  "coins": 0,
  "trackerCount": 3,
  "trackerLimit": 5
}
```

`trackerLimit` = `subscribed ? 100 : 5`.  
Cache this in state; re-fetch after any mutation (add/delete tracker, earn coins, subscribe).

### POST /api/devices

```
POST /api/devices
Authorization: Bearer <token>
Content-Type: application/json

{ "fcmToken": "<fcm-token>", "platform": "android" }
```

`platform`: `"android"` | `"ios"` | `"web"`

Response `201`: `{ "id": "device-doc-id" }`

Call again on `FirebaseMessaging.instance.onTokenRefresh` — backend upserts by token.

```dart
FirebaseMessaging.instance.onTokenRefresh.listen((token) => registerDevice(token));
```

---

## Screen: Home — Notice Feed

**Goal:** show latest notices across all trackers. Two tabs: Mine / Global.

### Tab: Mine (requires auth)

```
GET /api/notices?mode=mine&limit=20&startAfter=<cursor>
Authorization: Bearer <token>
```

### Tab: Global (no auth)

```
GET /api/notices?mode=global&limit=20&startAfter=<cursor>
```

Response (both):
```json
{
  "notices": [
    {
      "id": "ZpauwXqYtNJjiAkKwxpM",
      "trackerId": "mbX5sVLRaI2xzjSOBwSf",
      "title": "Re-circular for Chief Legal Affairs Officer",
      "summary": "Contractual CLAO position re-advertised.",
      "link": "https://erecruitment.bb.org.bd/career/TOR_CLAO.pdf",
      "publishedDate": null,
      "readAt": null,
      "createdAt": { "_seconds": 1782308563, "_nanoseconds": 0 }
    }
  ],
  "pagination": { "hasMore": true, "nextCursor": "ZpauwXqYtNJjiAkKwxpM" }
}
```

Pagination: pass `startAfter=<nextCursor>` for next page. Stop when `hasMore: false`.

`readAt: null` = unread → show bold / blue dot.

### Mark single notice read

```
PATCH /api/notices/:noticeId/read
Authorization: Bearer <token>
```

No body, no `Content-Type` header needed. Response `204`.

Call when user taps a notice or it becomes visible on screen.

### FCM: new_notice tap (from background/terminated)

```dart
FirebaseMessaging.onMessageOpenedApp.listen((message) {
  if (message.data['type'] == 'new_notice') {
    final noticeId = message.data['noticeId'];
    navigateTo(NoticeDetailScreen(noticeId: noticeId));
  }
});
```

---

## Screen: Tracker List

**Goal:** manage user's trackers, see active/inactive state.

### GET /api/trackers

```
GET /api/trackers
Authorization: Bearer <token>
```

Response `200`:
```json
{
  "trackers": [
    {
      "id": "mbX5sVLRaI2xzjSOBwSf",
      "uid": "VgX7tBRtESYrFGC7vseSMYY9SBm1",
      "url": "https://erecruitment.bb.org.bd/index.php",
      "prompt": "track job postings and announcements",
      "active": true,
      "sourceId": "sha256-of-url",
      "global": false,
      "lastCheckedAt": { "_seconds": 1782373347, "_nanoseconds": 0 },
      "lastManualScrapeAt": null,
      "createdAt": { "_seconds": 1782216721, "_nanoseconds": 0 }
    }
  ]
}
```

Show `active` as a toggle. Show `lastCheckedAt` as "Last checked X ago".

### Toggle active

```
PATCH /api/trackers/:id
Authorization: Bearer <token>
```

No body needed. Response `200`: `{ "active": false }`

Toggling inactive frees the tracker slot. Toggling back to active re-consumes it.

Error `403`: tracker limit reached (can't re-activate without coins/subscription).

### Delete tracker

```
DELETE /api/trackers/:id
Authorization: Bearer <token>
```

Response `204`. Re-fetch `GET /api/me` after to update `trackerCount`.

### Show coin status in header

If `trackerCount > 5` and not subscribed, show coin balance with days-remaining estimate:
- `"${coins} coins (~${coins} days remaining for ${trackerCount - 5} extra trackers)"`

---

## Screen: Add Tracker

**Goal:** create new tracker, handle limits and global flag.

Show warning banner if anonymous:
> *"Since you're not logged in, this tracker and its notices will be public. Log in to keep them private."*

`global` toggle is locked `true` for anonymous users.

### POST /api/trackers

```
POST /api/trackers
Authorization: Bearer <token>
Content-Type: application/json

{
  "url": "https://www.kuet.ac.bd/notices/all",
  "prompt": "Track the notices",
  "global": false,
  "integrityToken": "<play-integrity-token>"
}
```

Get integrity token:
```dart
final result = await PlayIntegrity.requestIntegrityToken(
  nonce: base64Encode(utf8.encode(url + uid)),
);
final integrityToken = result.token;
```

Response `201`:
```json
{
  "id": "8B5ywv5KXritgV8C5CMl",
  "tracker": {
    "id": "8B5ywv5KXritgV8C5CMl",
    "uid": "VgX7tBRtESYrFGC7vseSMYY9SBm1",
    "url": "https://www.kuet.ac.bd/notices/all",
    "prompt": "Track the notices",
    "active": true,
    "sourceId": "abc123...",
    "global": false,
    "lastManualScrapeAt": null,
    "lastCheckedAt": null,
    "createdAt": { "_seconds": 1782216506, "_nanoseconds": 0 }
  }
}
```

Error responses:

| Code | Message | UI |
|------|---------|-----|
| `400` | Invalid URL / integrity token required | Field error |
| `403` | Tracker limit reached | Show paywall (§ Coins/Paywall screen) |
| `429` | Rate limited | "Try again later" |

**Tracker limit flow:**
```
403 TRACKER_LIMIT_REACHED
  ↓
Show bottom sheet:
  - "Watch an ad to earn coins" → AdMob rewarded ad
  - "Subscribe for 100 trackers" → paywall
```

### Edit tracker (prompt / global)

URL cannot be changed. Delete + recreate instead.

```
PUT /api/trackers/:id
Authorization: Bearer <token>
Content-Type: application/json

{ "prompt": "new prompt text", "global": false }
```

Response `200`: `{ "tracker": { ...TrackerDoc } }`

---

## Screen: Tracker Notices

**Goal:** show all notices for a single tracker, manual scrape button.

### GET /api/notices/:trackerId

```
GET /api/notices/:trackerId?limit=20&startAfter=<cursor>
Authorization: Bearer <token>
```

Response `200`:
```json
{
  "notices": [...],
  "pagination": { "hasMore": false, "nextCursor": null }
}
```

### Mark all read

```
PATCH /api/notices/:trackerId/read-all
Authorization: Bearer <token>
```

No body needed. Response `204`.

### Manual scrape (check now)

```
POST /api/trackers/:id/scrape
Authorization: Bearer <token>
Content-Type: application/json
Body: {}
```

Response `202`: `{ "message": "Scrape job enqueued" }`

Error `429`: cooldown active — show countdown timer until 30 min after `lastManualScrapeAt`.

```dart
final lastScrape = tracker.lastManualScrapeAt;
if (lastScrape != null) {
  final cooldownUntil = lastScrape.add(const Duration(minutes: 30));
  if (DateTime.now().isBefore(cooldownUntil)) {
    // Show countdown: cooldownUntil.difference(DateTime.now())
  }
}
```

---

## Screen: Notice Detail

**Goal:** show full notice, open link.

### GET /api/notices/single/:noticeId

```
GET /api/notices/single/:noticeId
Authorization: Bearer <token>
```

Response `200`:
```json
{
  "notice": {
    "id": "ZpauwXqYtNJjiAkKwxpM",
    "trackerId": "mbX5sVLRaI2xzjSOBwSf",
    "title": "Re-circular for Chief Legal Affairs Officer",
    "summary": "Contractual CLAO position re-advertised.",
    "link": "https://erecruitment.bb.org.bd/career/TOR_CLAO.pdf",
    "publishedDate": null,
    "readAt": null,
    "createdAt": { "_seconds": 1782308563, "_nanoseconds": 0 }
  }
}
```

Use this for deep links from FCM taps.

Mark read on open:
```
PATCH /api/notices/:noticeId/read
Authorization: Bearer <token>
```

No body. Response `204`.

If `notice.link` is not empty: show "Open" button → `url_launcher`.

---

## Screen: Profile / Account

**Goal:** show auth state, subscription, link Google account.

Display from `GET /api/me`:
- Anonymous badge vs email
- Subscription status + expiry
- Coin balance
- Tracker count / limit bar

### Anonymous → Google login upgrade

```dart
final googleUser = await GoogleSignIn().signIn();
final cred = GoogleAuthProvider.credential(
  accessToken: (await googleUser!.authentication).accessToken,
  idToken: (await googleUser.authentication).idToken,
);

try {
  // Link — same UID, all data preserved
  await FirebaseAuth.instance.currentUser!.linkWithCredential(cred);
} on FirebaseAuthException catch (e) {
  if (e.code == 'credential-already-in-use') {
    // Prompt: "This Google account already has data. Switch accounts? Anonymous data will be lost."
    // If yes:
    await FirebaseAuth.instance.signInWithCredential(cred);
  }
}

// After link: re-register + refresh (UID unchanged)
await http.post('/api/auth/register', ...);
await refreshMe();
```

### Subscription restore (on new device / reinstall)

```dart
await InAppPurchase.instance.restorePurchases();
// purchaseStream fires → call /api/subscription/verify
```

---

## Screen: Coins / Paywall

**Goal:** earn coins via rewarded ads, or subscribe for 100 trackers.

### Coin logic

- Free: 5 trackers
- Each extra tracker (beyond 5): 1 coin/day deducted
- Max coins: 50
- Coins hit 0: extra trackers disabled by server overnight
- Re-enable disabled trackers: earn coins → `PATCH /api/trackers/:id` to toggle back on

### Rewarded ad flow (AdMob SSV)

App does NOT call backend after ad. AdMob calls backend SSV endpoint automatically.

```dart
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
        // Backend receives SSV callback, grants coins, sends FCM
        // Poll for confirmation
        await Future.delayed(const Duration(seconds: 3));
        await refreshMe(); // coins updated
      });
    },
    onAdFailedToLoad: (error) { /* handle */ },
  ),
);
```

FCM fires `coins_earned` when backend processes SSV. Listen:
```dart
FirebaseMessaging.onMessage.listen((message) {
  if (message.data['type'] == 'coins_earned') {
    final earned = message.data['coins'];
    final total = message.data['totalCoins'];
    showSnackbar('You earned $earned coins! Total: $total');
    refreshMe();
  }
});
```

### Google Play subscription

```dart
// 1. Query product
final result = await InAppPurchase.instance.queryProductDetails({'notice_watch_premium'});

// 2. Buy
await InAppPurchase.instance.buyNonConsumable(
  purchaseParam: PurchaseParam(productDetails: result.productDetails.first),
);

// 3. Listen
InAppPurchase.instance.purchaseStream.listen((purchases) async {
  for (final p in purchases) {
    if (p.status == PurchaseStatus.purchased) {
      // 4. Verify
      await http.post(
        Uri.parse('$baseUrl/api/subscription/verify'),
        headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
        body: jsonEncode({
          'purchaseToken': p.verificationData.serverVerificationData,
          'productId': p.productID,
        }),
      );
      // 5. Complete
      await InAppPurchase.instance.completePurchase(p);
      // 6. Refresh state
      await refreshMe();
    }
  }
});
```

`POST /api/subscription/verify` response `200`: `{ "subscribed": true }`  
`402`: purchase token not active on Play Store.

---

## FCM Notification Handling

All notifications carry a `data` map. Route by `data['type']`:

| type | Trigger | data fields | Action |
|------|---------|------------|--------|
| `new_notice` | New notice scraped | `trackerId`, `noticeId` | Navigate to NoticeDetailScreen |
| `coins_earned` | AdMob SSV processed | `coins`, `totalCoins` | Snackbar + refresh coins |
| `coins_low` | Balance ≤ 3 | `coins` | Snackbar: "Top up" CTA |
| `tracker_disabled` | Coins = 0, trackers disabled | — | Dialog: "Watch ad to re-enable" |

```dart
// Foreground
FirebaseMessaging.onMessage.listen((message) {
  switch (message.data['type']) {
    case 'new_notice':
      // Show in-app banner
      break;
    case 'tracker_disabled':
      showDialog(/* Watch ad / Subscribe */);
      break;
    case 'coins_low':
      showSnackbar('Only ${message.data['coins']} coins left. Watch an ad to top up.');
      break;
    case 'coins_earned':
      showSnackbar('Earned ${message.data['coins']} coins!');
      refreshMe();
      break;
  }
});

// Tap from background/terminated
FirebaseMessaging.onMessageOpenedApp.listen((message) {
  if (message.data['type'] == 'new_notice') {
    navigateTo(NoticeDetailScreen(noticeId: message.data['noticeId']));
  }
});
```

---

## Error Handling

| Status | Meaning | Action |
|--------|---------|--------|
| `401` | Expired or missing token | `getIdToken(force: true)` → retry once |
| `400` | Validation error | Show field message from `message` field |
| `402` | Subscription not active | Show paywall |
| `403` | Tracker limit / not owner | Show coin/subscribe prompt |
| `404` | Not found | Show empty state |
| `429` | Rate limit / cooldown | Show countdown or "try later" |
| `500` | Server error | Generic error + log to Crashlytics |

---

## Environment Config

```dart
const baseUrl = String.fromEnvironment('API_BASE_URL',
    defaultValue: 'http://localhost:5674');
const admobRewardedId = String.fromEnvironment('ADMOB_REWARDED_ID');
```

Firebase config (hardcode in `google-services.json` / `GoogleService-Info.plist`):
```
projectId: notice-watch
appId (android): 1:946705632610:web:b9bb208c952c38ee84303b
messagingSenderId: 946705632610
```

---

## Full API Reference

```
Auth
  POST   /api/auth/register                  Create/get UserDoc (idempotent, 201)
  GET    /api/me                             Profile, coins, limits, subscription

Trackers
  POST   /api/trackers                       Create tracker (201)
  GET    /api/trackers                       List all user trackers
  GET    /api/trackers/:id                   Single tracker
  PUT    /api/trackers/:id                   Edit prompt / global (URL immutable)
  DELETE /api/trackers/:id                   Delete (204)
  PATCH  /api/trackers/:id                   Toggle active/inactive (200 {active: bool})
  POST   /api/trackers/:id/scrape            Manual check now, 30min cooldown (202)

Notices
  GET    /api/notices?mode=mine              Cross-tracker feed, auth required
  GET    /api/notices?mode=global            Cross-tracker feed, no auth
  GET    /api/notices/single/:noticeId       Single notice by ID (deep link)
  GET    /api/notices/:trackerId             Per-tracker notices, paginated
  PATCH  /api/notices/:noticeId/read         Mark single read (204, no body)
  PATCH  /api/notices/:trackerId/read-all    Mark all read for tracker (204, no body)

Devices
  POST   /api/devices                        Register FCM token {fcmToken, platform}
  GET    /api/devices                        List registered devices
  DELETE /api/devices/:id                    Unregister device (204)

Subscription
  POST   /api/subscription/verify            Verify Google Play purchase token

Ads
  GET    /api/ad/admob-ssv                   Called by AdMob servers only — not by app
```
