import zipfile, os, json, sys
base = os.path.dirname(os.path.abspath(__file__))
files = ['manifest.json', 'background.js', 'content.js', 'inject.js', 'sales_schema.js',
         'popup.html', 'popup.js', 'options.html', 'options.js',
         'bridge.js', 'bridge_main.js', 'rules.json', 'README.txt',
         'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png']
out = os.path.join(base, 'shopee_selector_ext.zip')
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        p = os.path.join(base, f)
        if not os.path.exists(p):
            print('missing:', f); sys.exit(1)
        z.write(p, f)
m = json.load(open(os.path.join(base, 'manifest.json'), encoding='utf-8'))
print('packed:', out)
print('version:', m['version'])
print('files:', len(z.namelist()))
print('size:', os.path.getsize(out), 'bytes')
