# Dim sum photos

One image per dish, named `<dish-id>.webp`, matching the ids in `DISHES`
(`gui/src/shell/dimsum.ts`). The card renders the photo and falls back to the
emoji stand-in only when a file is missing, so a partial set is fine.

These are real photographs from the shared dim sum catalog — **not generated
here**. They are centre-cropped to a square and downscaled to 192×192 WebP,
which is the size the card actually renders at 2x. The originals average
2.3 MB each; shipping those to draw a 48px thumbnail would have added most of a
gigabyte to an installer for no visible difference.

| File | Dish |
| --- | --- |
| `classic-har-gow.webp` | Classic Har Gow · 蝦餃 |
| `classic-siu-mai.webp` | Classic Siu Mai · 燒賣 |
| `classic-char-siu-bao.webp` | Classic Char Siu Bao · 叉燒包 |
| `steamed-chicken-with-black-fungus.webp` | Steamed Chicken with Black Fungus · 雲耳蒸雞 |
| `puff-pastry-egg-tarts.webp` | Puff Pastry Egg Tarts · 酥皮蛋撻 |
| `steamed-radish-cake.webp` | Steamed Radish Cake · 蒸蘿蔔糕 |
| `black-bean-chicken-feet.webp` | Steamed Chicken Feet in Black Bean Sauce · 豉汁蒸鳳爪 |
| `steamed-bean-curd-roll.webp` | Steamed Bean Curd Skin Roll · 鮮竹卷 |
| `traditional-big-bun.webp` | Traditional Big Bun · 大包 |
| `steamed-beef-balls.webp` | Steamed Beef Balls · 山竹牛肉 |
| `sausage-turnip-pudding.webp` | Turnip Pudding with Chinese Sausage · 臘味蘿蔔糕 |

Requirements for anything added here: bundled locally (never a CDN or a
tracking pixel), square, at least 96×96 so it stays sharp at 2x, and small —
this ships inside the installer. The card names the dish in text beside the
image, so the image is marked decorative and needs no alt text of its own.
