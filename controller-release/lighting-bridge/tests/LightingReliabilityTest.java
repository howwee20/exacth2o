package com.exacth2o.lighting;
import java.io.*;
public class LightingReliabilityTest {
 public static void main(String[] a)throws Exception {
  if(LightingAgentV2.retryDelay(1000,0)!=1000 || LightingAgentV2.retryDelay(1000,1)!=2000 || LightingAgentV2.retryDelay(1000,10)!=20000) throw new AssertionError("retry bounds");
  File f=new File(a[0],"rotation-test.log");
  for(int i=0;i<7;i++){RandomAccessFile w=new RandomAccessFile(f,"rw"); w.setLength(1048576);w.close();LightingAgentV2.rotateLog(f);}
  if(f.exists() || !new File(f+".3").exists() || new File(f+".4").exists())throw new AssertionError("retention");
  for(int i=1;i<=3;i++)new File(f+"."+i).delete();
  System.out.println("PASS retry delay, cap, recovery cadence, bounded log retention");
 }
}
