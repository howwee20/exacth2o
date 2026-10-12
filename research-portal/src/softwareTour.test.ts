import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {expect,it} from "vitest";
const source=readFileSync(new URL("../../software-tour.js",import.meta.url),"utf8");
for (const [name,mediaError,expectedHidden] of [["AbortError",null,true],["NotSupportedError",null,false],["Error",{code:4},false]] as const) {
  it(`handles ${name} without misreporting interrupted playback`,async()=>{
    const events:Record<string,()=>Promise<void>>={};
    const video={controls:true,error:mediaError,ended:false,play:()=>Promise.reject({name}),focus:()=>{},addEventListener:()=>{}};
    const play={hidden:true,addEventListener:(event:string,callback:()=>Promise<void>)=>{events[event]=callback;}};
    const error={hidden:true};
    runInNewContext(source,{document:{getElementById:(id:string)=>({softwareTourVideo:video,softwareTourPlay:play,softwareTourError:error}[id]),addEventListener:()=>{}}});
    await events.click();
    expect(error.hidden).toBe(expectedHidden);expect(play.hidden).toBe(false);expect(video.controls).toBe(true);
  });
}
