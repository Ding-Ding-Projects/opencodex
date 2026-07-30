# Dim sum photos

Drop one image per dish here, named `<dish-id>.webp`, and the surprise card
starts showing it — no code change needed. The card renders the photo first and
falls back to the labelled emoji stand-in only when the file is missing, so a
partial set is fine: dishes with art get art, the rest keep the stand-in.

Dish ids come from `DISHES` in `gui/src/shell/dimsum.ts`:

| id | dish |
| --- | --- |
| `har-gow` | Har gow (shrimp dumpling) · 蝦餃 |
| `siu-mai` | Siu mai (pork and shrimp dumpling) · 燒賣 |
| `char-siu-bao` | Char siu bao (barbecue pork bun) · 叉燒包 |
| `cheung-fun` | Cheung fun (rice noodle roll) · 腸粉 |
| `dan-tat` | Dan tat (egg tart) · 蛋撻 |
| `lo-bak-go` | Lo bak go (turnip cake) · 蘿蔔糕 |
| `fung-zao` | Fung zao (chicken feet) · 鳳爪 |
| `nor-mai-gai` | Nor mai gai (sticky rice in lotus leaf) · 糯米雞 |

Requirements: bundled locally (never a CDN or a tracking pixel), square, at
least 96×96 so it stays sharp at 2x, and small — this ships inside the
installer. The card names the dish in text beside the image, so the image is
marked decorative and needs no alt text of its own.
