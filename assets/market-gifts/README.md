# Marketplace gift collection artwork

These 111 collection thumbnails are original Telegram gift artwork, downloaded from the existing project artwork source `https://cdn.changes.tg/gifts/models/{encoded collection name}/png/Original.png` on 2026-11-12. They are resized proportionally to at most 420 × 420 and encoded as WebP without adding or generating content.

`catalog-images.json` maps normalized collection names to local files. The NFT selector uses local thumbnails to avoid external hotlink failures. Individual verified NFT listings still use the existing `/api/collectible-media/{collectibleId}` endpoint first to show the unique collectible's actual model and backdrop; collection artwork is a fallback only.

Artwork is not proof of ownership or stock. Available offers come exclusively from verified, active marketplace listings. This directory does not create gifts, listings, prices or balances. Collections newly returned by Telegram can use the existing original-artwork URL and Telegram media endpoint until their thumbnails are added locally.
