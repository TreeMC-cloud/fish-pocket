#!/usr/bin/env python3
"""Render the promo with headless Chrome and pipe frames to ffmpeg.

  render.py stills --lang zh --at 1.0,6.5,...   sample frames into ./out/stills
  render.py video  --lang zh --fps 60 --out x.mp4 [--audio a.wav]
"""
import argparse, asyncio, pathlib, subprocess, time
from playwright.async_api import async_playwright

HERE = pathlib.Path(__file__).resolve().parent


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mode', choices=['stills', 'video'])
    ap.add_argument('--lang', default='zh')
    ap.add_argument('--at', default='')
    ap.add_argument('--fps', type=int, default=60)
    ap.add_argument('--out', default=str(HERE / 'out/video.mp4'))
    ap.add_argument('--audio')
    ap.add_argument('--plate', help='plate directory relative to src/, e.g. plates/zh (see README.md)')
    ap.add_argument('--browser', help='Chromium executable to use instead of the installed Chrome')
    a = ap.parse_args()

    async with async_playwright() as p:
        launch = {'executable_path': a.browser} if a.browser else {'channel': 'chrome'}
        browser = await p.chromium.launch(**launch, headless=True, args=['--allow-file-access-from-files', '--force-device-scale-factor=1'])
        page = await browser.new_page(viewport={'width': 1920, 'height': 1080})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        plate = f'&plate={a.plate}' if a.plate else ''
        await page.goto(f'file://{HERE}/index.html?lang={a.lang}{plate}')
        await page.evaluate('document.fonts.ready')
        duration = await page.evaluate('window.DURATION')

        if a.mode == 'stills':
            out = HERE / 'out/stills'
            out.mkdir(parents=True, exist_ok=True)
            for t in [float(x) for x in a.at.split(',') if x]:
                await page.evaluate('t => renderAt(t)', t)
                await page.screenshot(path=str(out / f'{a.lang}-{t:06.2f}.jpg'), type='jpeg', quality=88)
        else:
            cmd = ['ffmpeg', '-v', 'error', '-y', '-f', 'image2pipe', '-framerate', str(a.fps), '-c:v', 'mjpeg', '-i', '-']
            if a.audio:
                cmd += ['-i', a.audio, '-c:a', 'aac', '-b:a', '192k', '-shortest']
            cmd += ['-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', a.out]
            ff = subprocess.Popen(cmd, stdin=subprocess.PIPE)
            n = int(duration * a.fps)
            t0 = time.time()
            for i in range(n):
                await page.evaluate('t => renderAt(t)', i / a.fps)
                ff.stdin.write(await page.screenshot(type='jpeg', quality=96))
                if i % 300 == 0:
                    print(f'{i}/{n} {i / max(time.time() - t0, .01):.1f} fps', flush=True)
            ff.stdin.close()
            ff.wait()
            print('done', a.out, ff.returncode)
        await browser.close()
        for e in errors[:10]:
            print('PAGE ERROR:', e)


asyncio.run(main())
