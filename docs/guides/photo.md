# A product from a photo

For requests built on a product photograph or a cutout (PNG with transparency).

- A supplied photo is the product. Use it as given: no redrawing, no recolouring of the product
  itself, no generated replacement.
- Cutting a product out of a photo with its own background by hand is not reliable enough to
  promise; ask for a cutout.
- Label the result as photo or hybrid in `inspect().subject` (`kind: 'photo'`) and in the
  summary. Never describe it as 3D. A card that turns far enough shows it is flat.
- Decode images with `io.image` (or the `render-image-textures` item for atlases and other
  formats), never the platform's own decoder, so the browser and Node render the same pixels.
- Record the photo in `ASSETS.md` as supplied by the person, with its sha256.

Check with review, and look at the moments that show the photo at full size
(`npx shaderera still <t>`): edges of the cutout and its scale against the type.
