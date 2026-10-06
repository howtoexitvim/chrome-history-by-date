# Icons

The history icon from Google Material Symbols, matching the icon Chrome uses
on its own `chrome://history` page.

`icon.svg` is the source. The PNGs are generated from it:

```bash
for s in 16 32 48 128; do
  rsvg-convert -w $s -h $s icon.svg -o icon${s}.png
done
```

The fill color `#5f6368` matches the neutral grey Chrome uses for toolbar icons.

The SVG and derived PNGs are licensed under Apache License 2.0. See
[the license](../licenses/Apache-2.0.txt) and
[third-party notices](../THIRD_PARTY_NOTICES.md).
