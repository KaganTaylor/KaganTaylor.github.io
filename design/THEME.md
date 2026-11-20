# Theme: Void Deep Split

Dark technology: the feel of an instrument readout or a headset overlay seen in a dark room. It is a mood that unifies the design, not something to build literally.

## Principles

- **Black ground.** The background is pure black and text is grey.
- **Accents are lines.** Green and red appear only as thin strokes (1px, or 0.5px), outlines and small amounts of text. There are no solid fills, at most a faint tint on hover.
- **Either accent can lead.** Use whichever looks right in context.
- **Two levels of red, one hue.** Use `red-line` for lines and drawings and `red-text` for anything that has to be read. Don't mix the two on one small element: a tag uses `red-text` for both its border and its text. A line that carries meaning on its own, such as a focus ring or the only marker of a selection, uses `red-text`. Green has one level.
- **Texture.** Hairline grids and corner brackets.

## Palette

| Token      | Hex       | Contrast on bg | Use                                 |
|------------|-----------|----------------|-------------------------------------|
| `bg`       | `#000000` |                | Background                          |
| `surface`  | `#090909` |                | Raised and selected areas           |
| `line`     | `#1b1b1b` | 1.2:1          | Neutral hairlines                   |
| `text`     | `#dcdcdc` | 15.3:1         | Body text                           |
| `muted`    | `#7d7d7d` | 5.1:1          | Secondary text                      |
| `green`    | `#568f26` | 5.4:1          | Lines and text                      |
| `red-line` | `#a8221d` | 2.9:1          | Lines and drawings, decoration only |
| `red-text` | `#db322c` | 4.5:1          | Red text, meaningful lines          |

## Still to decide

- Typeface
- Layout
- Interaction flow for activity and publications

Prototype eye and hand drawings from the theme exploration are in `wireframes.js`.
