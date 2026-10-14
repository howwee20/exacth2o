"""Render the 24-second cursor-led software tour from unmodified browser captures.
Requires Pillow and FFmpeg. All cursor/camera motion is editorial; UI states are real.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import subprocess, json, hashlib, os, shutil, math

repo=Path(__file__).resolve().parent.parent
captures=repo/'design/showcase-cursor-20261013'
output=repo/'media'
scratch=Path(os.environ.get('SHOWCASE_SCRATCH','/tmp/exacth2o-cursor-showcase'));scratch.mkdir(exist_ok=True)
ff=os.environ.get('FFMPEG') or shutil.which('ffmpeg') or 'ffmpeg'
font_dir=Path(os.environ.get('SHOWCASE_FONTS','/System/Library/Fonts/Supplemental'))
regular=lambda n:ImageFont.truetype(str(font_dir/'Arial.ttf'),n)
bold=lambda n:ImageFont.truetype(str(font_dir/'Arial Bold.ttf'),n)
W,H,FPS,DURATION=1920,1200,60,24
BG='#101f1a'; AQUA='#91e4d2'
# (seconds, capture, blend duration). Every changed state follows its corresponding click.
states=[(0,'01-drought.png',0),(1.12,'02-history.png',.18),(5.02,'03-export.png',.18),
 (7.30,'05-recovery-all.png',.24),(8.42,'07-recovery.png',.20),(10.32,'08-overlay.png',.14),
 (13.52,'09-save-empty.png',.10),(14.00,'10-type-0.png',0),(14.18,'10-type-1.png',0),
 (14.36,'10-type-2.png',0),(14.58,'10-type-3.png',0),(15.92,'11-saved.png',.12),(20.42,'12-return.png',.20)]
images={name:Image.open(captures/name).convert('RGB') for _,name,_ in states}
assert all(im.size==(1600,1000) for im in images.values()),'Capture must include the complete 1600x1000 viewport'
# Smooth cursor movements with short rests before and after every click.
# Coordinates are measured in the source UI, before the editorial camera transform.
keys=[(0,880,630),(.30,880,630),(.98,98,322),(1.38,98,322),(2.1,205,590),
 (3.25,700,870),(3.65,700,870),(4.78,1525,139),(5.32,1525,139),
 (6.12,900,510),(6.75,900,510),(7.29,900,510),(7.30,900,510),
 (8.18,1474,616),(8.65,1474,616),(10.08,1479,58),(10.6,1479,58),
 (11.40,370,480),(12.2,900,520),(13.27,1512,152),(13.76,1512,152),
 (14.00,1380,196),(14.90,1380,196),(15.66,1112,243),(16.22,1112,243),
 (17.00,450,400),(18.40,965,430),(19.05,965,430),(20.17,1544,58),(20.72,1544,58),(21.25,1544,58)]
clicks=[(1.05,98,322),(4.94,1525,139),(8.34,1474,616),(10.24,1479,58),(13.44,1512,152),(15.84,1112,243),(20.34,1544,58)]
chapters=[(0,'RECORDED DROUGHT DATA','See the whole experiment.'),(4.7,'RECORDED MEASUREMENTS','Take the record with you.'),
 (7.3,'DERIVED RECOVERY SCENARIO','Compare recovery timing.'),(10.1,'DERIVED RECOVERY SCENARIO','Put irrigation in context.'),
 (13.2,'SAVED COMPARISONS','Pick up where you left off.')]

def ease(p):
 p=max(0,min(1,p));return p*p*p*(p*(p*6-15)+10)
def cursor_at(t):
 for a,b in zip(keys,keys[1:]):
  if a[0]<=t<=b[0]:
   p=ease((t-a[0])/(b[0]-a[0]));dx=b[1]-a[1];dy=b[2]-a[2]
   arc=math.sin(math.pi*p)*min(24,math.hypot(dx,dy)*.035)
   return a[1]+dx*p-dy/max(1,math.hypot(dx,dy))*arc,a[2]+dy*p+dx/max(1,math.hypot(dx,dy))*arc
 return keys[-1][1:]
def camera(t):
 # Small focus shifts keep the pointer and target on screen, without a constant drifting zoom.
 z=1+.025*ease((t-1.6)/1.3) if t<4.7 else 1
 if 8.7<=t<20.4:z=1+.025*ease((t-8.7)/1.3)
 return z,(z-1)*800,(z-1)*400

def render_screen(t):
 i=max(i for i,s in enumerate(states) if s[0]<=t)
 at,name,blend=states[i];screen=images[name]
 if i and blend and t<at+blend:screen=Image.blend(images[states[i-1][1]],screen,ease((t-at)/blend))
 z,px,py=camera(t)
 screen=screen.transform((1600,1000),Image.Transform.AFFINE,(1/z,0,px/z,0,1/z,py/z),Image.Resampling.BICUBIC)
 base=Image.new('RGB',(W,H),BG);base.paste(screen,(160,174))
 d=ImageDraw.Draw(base);d.rounded_rectangle((159,173,1760,1174),radius=8,outline='#355347',width=1)
 chapter=max(i for i,c in enumerate(chapters) if c[0]<=t)
 at,kicker,title=chapters[chapter]
 d.text((160,31),kicker,font=regular(20),fill=AQUA)
 d.text((160,72),title,font=bold(48),fill='white')
 d.text((1640,43),'ExactH2O',font=bold(25),fill=AQUA,anchor='ra')
 x,y=cursor_at(t);x=160+x*z-px;y=174+y*z-py
 # One precise click halo, never a persistent spotlight that obscures the data.
 overlay=Image.new('RGBA',(W,H));od=ImageDraw.Draw(overlay)
 for at,cx,cy in clicks:
  age=t-at
  if 0<=age<.42:
   cx=160+cx*z-px;cy=174+cy*z-py;r=7+25*ease(age/.42)
   od.ellipse((cx-r,cy-r,cx+r,cy+r),outline=(65,159,143,round(150*(1-age/.42))),width=3)
 base=Image.alpha_composite(base.convert('RGBA'),overlay)
 # Supersampled native-style pointer with a fine white edge and a soft shadow.
 press=min((abs(t-at) for at,_,_ in clicks),default=1)
 scale=1-.12*max(0,1-press/.10)
 pointer=cursor.resize((round(62*scale),round(78*scale)),Image.Resampling.LANCZOS)
 base.alpha_composite(pointer,(round(x-9*scale),round(y-8*scale)))
 return base.convert('RGB')

cursor=Image.new('RGBA',(186,234));d=ImageDraw.Draw(cursor)
poly=[(27,24),(27,144),(56,117),(79,168),(103,157),(80,108),(122,108)]
shadow=Image.new('RGBA',cursor.size);ImageDraw.Draw(shadow).polygon([(x+3,y+6) for x,y in poly],fill=(0,0,0,100))
cursor=Image.alpha_composite(cursor,shadow.filter(ImageFilter.GaussianBlur(5)));d=ImageDraw.Draw(cursor)
d.polygon(poly,fill='#152720');d.line(poly+[poly[0]],fill='white',width=6,joint='curve')
cursor=cursor.resize((62,78),Image.Resampling.LANCZOS)
# Actual brand asset on the same dark field as the website.
end=Image.new('RGB',(W,H),BG)
logo=Image.open(repo/'research-portal/src/assets/exacth2o-logo.jpeg').convert('RGB').crop((80,410,1380,670)).resize((800,160),Image.Resampling.LANCZOS)
pixels=logo.load();mask=Image.new('L',logo.size);m=mask.load()
for y in range(logo.height):
 for x in range(logo.width):m[x,y]=max(0,min(255,round((max(pixels[x,y])-28)*255/55)))
end.paste(logo,(560,420),mask);d=ImageDraw.Draw(end)
d.text((960,642),'Precision irrigation for research.',font=regular(36),fill='white',anchor='mt')
d.text((960,726),'exacth2o.com/demo',font=regular(28),fill='#a6b7ae',anchor='mt')

def frame(t):
 if t>=21.58:return end
 im=render_screen(min(t,21.26))
 return Image.blend(im,end,ease((t-21.26)/.32)) if t>=21.26 else im

stem='software-tour-cursor-20261013'
mp4=output/(stem+'.mp4');webm=output/(stem+'.webm')
args=[ff,'-y','-loglevel','error','-f','rawvideo','-pixel_format','rgb24','-video_size',f'{W}x{H}','-framerate',str(FPS),'-i','-',
 '-an','-c:v','libx264','-crf','18','-preset','fast','-pix_fmt','yuv420p','-movflags','+faststart',str(mp4)]
if os.environ.get('SHOWCASE_STILLS_ONLY'):
 for t in [1.2,2.8,5.4,8.6,10.5,13.65,15.98,18,20.65,22.3]:frame(t).save(scratch/f'frame-{t}.jpg',quality=93)
else:
 p=subprocess.Popen(args,stdin=subprocess.PIPE)
 for n in range(FPS*DURATION):
  p.stdin.write(frame(n/FPS).tobytes())
  if n%300==0:print(f'Rendered {n}/{FPS*DURATION} frames',flush=True)
 p.stdin.close()
 if p.wait():raise SystemExit('MP4 render failed')
 subprocess.run([ff,'-y','-loglevel','error','-i',str(mp4),'-c:v','libvpx-vp9','-crf','31','-b:v','0','-row-mt','1','-cpu-used','4',str(webm)],check=True)
 frame(2.8).save(output/'software-tour-poster-cursor-20261013.jpg',quality=94)
 (output/(stem+'-provenance.json')).write_text(json.dumps({'created':'2026-10-13','durationSeconds':DURATION,'fps':FPS,'dimensions':[W,H],
 'method':'Real browser UI states from the published ExactH2O demo, edited into a continuous cursor-led walkthrough. Editorial pointer, click halos, camera motion and short transitions; screen content is unchanged.',
 'clicks':[{'at':a,'position':[x,y]} for a,x,y in clicks],
 'captures':[{'file':f,'sha256':hashlib.sha256((captures/f).read_bytes()).hexdigest()} for f in images],
 'recordedData':'Binod CSV, original values preserved. Display dates shifted for replay. Export shot covers the selected last-three-days window. Recovery and irrigation shots are derived scenarios.'},indent=2)+'\n')
 print('Rendered',DURATION,'seconds at',FPS,'fps;',mp4.stat().st_size,webm.stat().st_size,'bytes',flush=True)
