from pathlib import Path
from PIL import Image, ImageDraw

home = Path('/var/lib/llm-desktop/disk/home')
for folder in ['.config/openbox', '.config/tint2', '.themes/PixelKawaii/openbox-3', '.config/gtk-3.0', '.config/fontconfig']:
    (home / folder).mkdir(parents=True, exist_ok=True)
image = Image.new('RGB', (256, 192), '#eee3fa')
draw = ImageDraw.Draw(image)
for horizontal in range(8, 256, 24):
    for vertical in range(8, 192, 24):
        draw.rectangle((horizontal, vertical, horizontal + 1, vertical + 1), fill='#d5bce8')
draw.rectangle((38, 40, 219, 143), fill='#695078')
draw.rectangle((35, 37, 216, 140), fill='#fff5fc')
draw.rectangle((38, 40, 213, 53), fill='#e7aed1')
for horizontal in [197, 204]:
    draw.rectangle((horizontal, 44, horizontal + 4, 48), fill='#fff5fc')
draw.rectangle((100, 77, 151, 119), fill='#c8e3de')
draw.polygon([(100, 80), (100, 66), (114, 77)], fill='#c8e3de')
draw.polygon([(137, 77), (151, 66), (151, 80)], fill='#c8e3de')
for horizontal in [112, 138]:
    draw.rectangle((horizontal, 88, horizontal + 3, 93), fill='#695078')
draw.rectangle((123, 99, 129, 102), fill='#e7aed1')
for horizontal in [53, 190]:
    draw.rectangle((horizontal, 76, horizontal + 2, 88), fill='#e6c270')
    draw.rectangle((horizontal - 4, 80, horizontal + 6, 82), fill='#e6c270')
image.resize((1024, 768), Image.Resampling.NEAREST).save(home / 'wallpaper.png')
(home / '.themes/PixelKawaii/openbox-3/themerc').write_text('''window.active.title.bg: Flat Solid
window.active.title.bg.color: #e7aed1
window.active.label.bg: ParentRelative
window.active.label.text.color: #47374f
window.inactive.title.bg: Flat Solid
window.inactive.title.bg.color: #d8c7e5
window.inactive.label.bg: ParentRelative
window.inactive.label.text.color: #695078
window.active.button.unpressed.bg: ParentRelative
window.active.button.unpressed.image.color: #695078
window.inactive.button.unpressed.bg: ParentRelative
window.inactive.button.unpressed.image.color: #695078
border.width: 3
border.color: #695078
window.handle.width: 0
padding.width: 6
padding.height: 5
window.label.text.justify: center
''')
(home / '.config/openbox/rc.xml').write_text('''<openbox_config xmlns="http://openbox.org/3.4/rc">
<theme><name>PixelKawaii</name><titleLayout>NLIMC</titleLayout><font place="ActiveWindow"><name>Pixel Unicode</name><size>9</size><weight>Normal</weight></font><font place="InactiveWindow"><name>Pixel Unicode</name><size>9</size></font></theme>
<desktops><number>1</number></desktops><focus><focusNew>yes</focusNew></focus>
<keyboard><keybind key="A-F4"><action name="Close"/></keybind><keybind key="A-Tab"><action name="NextWindow"/></keybind><keybind key="W-Return"><action name="Execute"><command>xterm</command></action></keybind></keyboard>
<mouse><context name="Titlebar"><mousebind button="Left" action="Drag"><action name="Move"/></mousebind><mousebind button="Left" action="DoubleClick"><action name="ToggleMaximize"/></mousebind></context><context name="Close"><mousebind button="Left" action="Click"><action name="Close"/></mousebind></context></mouse>
</openbox_config>''')
(home / '.config/tint2/tint2rc').write_text('''rounded = 0
border_width = 2
background_color = #fff5fc 100
border_color = #695078 100
panel_items = TC
panel_monitor = all
panel_position = bottom center horizontal
panel_size = 100% 32
panel_background_id = 1
taskbar_mode = single_desktop
task_icon = 1
task_text = 1
task_font = Pixel Unicode 9
task_font_color = #47374f 100
task_maximum_size = 230 28
time1_format = %H:%M
time1_font = Pixel Unicode 9
clock_font_color = #695078 100
''')
(home / '.config/gtk-3.0/settings.ini').write_text('[Settings]\ngtk-theme-name=Adwaita\ngtk-font-name=Pixel Unicode 9\ngtk-enable-animations=false\n')
(home / '.Xresources').write_text('XTerm*background: #fff5fc\nXTerm*foreground: #47374f\nXTerm*faceName: Pixel Unicode\nXTerm*faceSize: 18\nXTerm*renderFont: true\nXTerm*utf8: 2\n')
(home / '.config/fontconfig/fonts.conf').write_text('''<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
<alias><family>Pixel Unicode</family><prefer><family>Fusion Pixel 12px Mono zh-Hans</family><family>Fusion Pixel 12px Mono ja</family><family>Noto Sans CJK SC</family></prefer></alias>
<alias><family>monospace</family><prefer><family>Pixel Unicode</family></prefer></alias>
<alias><family>sans-serif</family><prefer><family>Pixel Unicode</family></prefer></alias>
<match target="font"><test name="family" compare="contains"><string>Fusion Pixel</string></test><edit name="antialias" mode="assign"><bool>false</bool></edit><edit name="hinting" mode="assign"><bool>false</bool></edit></match>
</fontconfig>''')
