#!/usr/bin/env python3
import os
import sys
from pathlib import Path

from AppKit import (
    NSBitmapImageFileTypePNG,
    NSBitmapImageRep,
    NSCalibratedRGBColorSpace,
    NSColor,
    NSCompositingOperationSourceOver,
    NSGraphicsContext,
    NSImage,
    NSMakeRect,
    NSMakeSize,
    NSRectFill,
)


ASSETS = [
    ("01-plugin-popup", 1280, 800),
    ("02-batch-export", 1280, 800),
    ("03-export-theme-settings", 1280, 800),
    ("04-select-messages-export", 1280, 800),
    ("05-local-private-report", 1280, 800),
    ("promo-small-440x280", 440, 280),
    ("promo-marquee-1400x560", 1400, 560),
]


def render_svg(svg_path: Path, png_path: Path, width: int, height: int) -> None:
    image = NSImage.alloc().initWithContentsOfFile_(str(svg_path))
    if image is None:
        raise RuntimeError(f"Unable to read SVG: {svg_path}")

    rep = NSBitmapImageRep.alloc().initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bitmapFormat_bytesPerRow_bitsPerPixel_(
        None,
        width,
        height,
        8,
        4,
        True,
        False,
        NSCalibratedRGBColorSpace,
        0,
        0,
        0,
    )
    rep.setSize_(NSMakeSize(width, height))

    context = NSGraphicsContext.graphicsContextWithBitmapImageRep_(rep)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.setCurrentContext_(context)
    NSColor.clearColor().set()
    NSRectFill(NSMakeRect(0, 0, width, height))
    image.drawInRect_fromRect_operation_fraction_(
        NSMakeRect(0, 0, width, height),
        NSMakeRect(0, 0, 0, 0),
        NSCompositingOperationSourceOver,
        1.0,
    )
    NSGraphicsContext.restoreGraphicsState()

    png_path.parent.mkdir(parents=True, exist_ok=True)
    if png_path.exists():
        png_path.unlink()
    data = rep.representationUsingType_properties_(NSBitmapImageFileTypePNG, {})
    if data is None:
        raise RuntimeError(f"Unable to encode PNG: {png_path}")
    data.writeToFile_atomically_(str(png_path), True)
    if not png_path.exists():
        raise RuntimeError(f"Failed to write PNG: {png_path}")


def render_dir(render_dir: Path) -> None:
    for locale_dir in [render_dir, render_dir / "zh-CN"]:
        if not locale_dir.is_dir():
            continue
        for name, width, height in ASSETS:
            svg_path = locale_dir / f"{name}.svg"
            png_path = locale_dir / f"{name}.png"
            if not svg_path.exists():
                raise FileNotFoundError(svg_path)
            render_svg(svg_path, png_path, width, height)
            print(f"Rendered {png_path.name} ({png_path.stat().st_size} bytes)")


def main() -> int:
    render_dir_arg = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent
    render_dir(render_dir_arg.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
