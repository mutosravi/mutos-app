#!/usr/bin/env python3
"""Builds public/board.html from src/shoot-board.html (the same board you use inside Claude).
The board file has no <html>/<head> wrapper, so this adds one plus the team app's scripts, which must load
before the board's own script: they supply window.claude (the database) and window.MUTOS_APP (crew pages)."""
import pathlib, sys
root = pathlib.Path(__file__).resolve().parent.parent
src = (root / 'src' / 'shoot-board.html').read_text(encoding='utf-8')
if '<html' in src.lower():
    sys.exit('src/shoot-board.html already has an <html> wrapper; expected the bare board file')
head = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#fbf6f2">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="apple-touch-icon" href="/icon-180.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Muto's">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;600;700;800&display=swap">
<link rel="stylesheet" href="/app.css">
<script src="/config.js"></script>
<script src="/app-core.js"></script>
<script src="/shim.js"></script>
<script src="/crew-sync.js"></script>
<script src="/team-updates.js"></script>
<script src="/clients.js"></script>
<script src="/icons.js"></script>
<script src="/home.js"></script>
</head>
<body>
'''
# the app's look (public/board-theme.css) goes straight after the board's own styles, so it wins and nothing flashes dark first
theme = (root / 'public' / 'board-theme.css').read_text(encoding='utf-8')
cut = src.index('</style>') + len('</style>')
out = head + src[:cut] + '\n<style id="app-theme">\n' + theme + '</style>' + src[cut:] + '\n</body>\n</html>\n'
(root / 'public' / 'board.html').write_text(out, encoding='utf-8')
print('public/board.html built,', len(out), 'bytes')
