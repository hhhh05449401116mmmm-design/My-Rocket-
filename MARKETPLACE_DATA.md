# Marketplace display data

The marketplace is an isolated read-only consumer of external metadata and prices. This release does not change PvP, Rocket, gift withdrawals, balances, listing/checkout transactions, or the existing instant-sale valuation engine.

## External collection prices

`marketplaceMarketData.js` reads the public [TelegramGiftsAssests price dataset](https://github.com/ssamy2/TelegramGiftsAssests/blob/main/Gifts_Details.json). The displayed price is the publisher's positive `floor_price_ton`; if absent, the minimum positive reported Portal/Getgems/MRKT provider value is used. This is an external collection-level reference floor, not a promise that a specific unique gift can be bought or sold for that amount in this game.

Updates are process-shared, in-flight deduplicated and cached for five minutes. The UI checks while the marketplace is visible, once a minute. The publisher's actual `last_updated` timestamp is displayed, not our request timestamp. Failed or old updates retain a clearly marked last-known price; unknown prices remain null, not zero or seeded estimates.

Percentage change compares the same floor-selection algorithm against an immutable published snapshot at or before the latest observation minus 24 hours. The historical snapshot must be within two hours of that target; otherwise the percentage remains unavailable. Historical discovery is cached for 30 minutes. The UI describes the period as approximately 24 hours.

## Full model metadata

`marketplaceModelCatalog.js` consumes [Changes gift model documents](https://cdn.changes.tg/gifts/documents.json). A bundled metadata-only fallback in `marketplaceModelCatalog.json` contains 7,942 current collection/model pairs across 124 collections, from the verified public snapshot with file modification time 2026-11-03T14:59:04Z. Historical `current:false` document records are excluded. Public metadata is refreshed in the background at most once every six hours, with shared requests and failure backoff. This is the complete known public snapshot, not a guarantee of real-time official Telegram completeness.

Model-specific images use separately encoded source collection and model names on the fixed Changes CDN. If a model image fails to load, no misleading base-collection image is substituted. Catalog names and public gift IDs are matched exactly; public IDs are retained internally for verified renames and not exposed as user/private metadata by the new API.

## Availability and filtering

`GET /api/market/traits?collection=...&kind=model` left-merges model metadata with actual eligible ACTIVE, verified, owned, unburned local listing counts. Zero means no matching offer in this game's marketplace. Counts are not total Telegram issued supply and are not manufactured from rarity percentages. Unknown global issued counts remain null. Backdrop/symbol options in this release remain derived from local offers and are explicitly identified as local-only when a complete external catalog is unavailable.

No selected NFT means the shop remains unfiltered across collections. The model picker presents all collections first; choosing a collection shows its models. Selecting a model also selects that exact collection, and zero-stock selections produce the existing unavailable-gift message. Arabic, English and Russian labels are supported without translating collection/model/player names.

## Verification

67 targeted marketplace, pricing, metadata and collectibles tests passed. Mobile tests passed in Arabic, English and Russian at 320/390/520px, including modal hit-testing above the account header/navigation, price change colors, all-gift defaults, exact model filtering and zero/positive local counts. The previous 5 unrelated PvP assertion failures were reproduced in the unmodified baseline; no new game regression was observed. Existing game tests were not changed to suppress those failures.
