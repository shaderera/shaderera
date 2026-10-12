What a placement accepts, as data for requirements.json `placements`: `deliver` checks each
delivered file against the placement its variant declares, and review judges text against its
safe area.

```json
{
  "version": 1,
  "placements": {
    "story": { "...": "copy an entry from delivery/placements.json" },
    "main": { "...": "another" }
  }
}
```

| Entry | What it checks |
|---|---|
| `meta-reels-ads` | mp4 or mov, H.264, 9:16, up to 15 min and 4 GB, **no edit list** (render with `--no-edit-list`), Meta's safe zone 14 % top, 35 % bottom, 6 % sides |
| `youtube-1080p30-sdr` | 8 Mb/s or more (render with `--bitrate 8M` for flat films), 48 or 96 kHz |
| `amazon-streaming-tv` | mp4 H.264 16:9 at 1920×1080 or more, 23.976–29.97 fps, spot lengths, 500 MB, **15 Mb/s or more** (`--bitrate 15M`), AAC stereo |
| `eu-broadcast-r128` | -23 LUFS ±0.5, true peak -1 dBTP (`--loudness=-23`) |
| `us-broadcast-a85` | -24 LKFS ±2, true peak -2 dBTP (`--loudness=-24`) |
| `dooh-obb-2026` | silent (`--no-audio`), H.264 at 25 or 30 fps, 10 Mb/s or less (`--maxrate 10M`), 500 MB |

Each entry says where its numbers come from and when they were read. Platforms change their specs:
check the source before a campaign and edit the entry, which is yours once copied. Combine entries
by merging their fields (a CTV spot that must also meet R128). Shaderera assumes none of this by
itself (decision 0011).
