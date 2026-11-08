// Windows qualification boundary. No desktop switching, global input or foreground APIs.
// Shared by the launcher and the directly invocable native helper; Add-Type compiles it.
using System;
using System.Text;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class NativeDesktopIsolation {
 const uint DesktopAccess = 0x00c7; // READ/WRITEOBJECTS, CREATEWINDOW/MENU, ENUMERATE; NOT SWITCHDESKTOP
 [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr attributes);
 [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
 [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
 [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint tid);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int size, out int needed);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobLimits info, int length);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out JobAccounting info, int length, IntPtr returned);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint ms);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr handle, uint code);
 [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long processTime, jobTime; public uint flags; public UIntPtr minWorkingSet, maxWorkingSet; public uint activeLimit; public UIntPtr affinity; public uint priority, scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct JobLimits { public BasicLimits basic; public IoCounters io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
 [StructLayout(LayoutKind.Sequential)] struct JobAccounting { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo { public int cb; public string reserved, desktop, title; public int x,y,w,h,xchars,ychars,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] public struct Child { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out Child child);
 delegate bool DesktopCallback(string name, IntPtr argument);
 [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool EnumDesktops(IntPtr station, DesktopCallback callback, IntPtr argument);
 static Exception Error(string operation) { return new Win32Exception(Marshal.GetLastWin32Error(), operation); }
 static string Name(IntPtr handle) {
  if(handle==IntPtr.Zero) throw Error("Missing desktop/station handle");
  int needed; var value=new StringBuilder(512);
  if(!GetUserObjectInformation(handle,2,value,1024,out needed)) throw Error("Desktop/station name query failed");
  return value.ToString();
 }
 public static string CurrentDesktop() { return Name(GetThreadDesktop(GetCurrentThreadId())); }
 public static void CheckNames(string expected, string actor, string input) {
  Guid nonce;
  if(expected==null || !expected.StartsWith("CodeCityNative-",StringComparison.Ordinal) || !Guid.TryParseExact(expected.Substring(15),"N",out nonce)) throw new Exception("Invalid owned desktop nonce");
  if(!String.Equals(expected,actor,StringComparison.Ordinal)) throw new Exception("Actor/target desktop mismatch");
  if(String.Equals(expected,input,StringComparison.OrdinalIgnoreCase)) throw new Exception("Owned desktop is the input desktop");
 }
 static void CheckDesktop(string expected, IntPtr desktop) {
  if(Name(GetProcessWindowStation())!="WinSta0") throw new Exception("Window station mismatch");
  var input=OpenInputDesktop(0,false,1); // query only, never SWITCHDESKTOP
  if(input==IntPtr.Zero) throw Error("Cannot prove non-input desktop");
  try { CheckNames(expected,Name(desktop),Name(input)); }
  finally { if(!CloseDesktop(input)) throw Error("Close input query handle failed"); }
 }
 public static IntPtr CreateOwnedDesktop(string name) {
  if(DesktopExists(name))throw new Exception("Desktop already exists");
  var desktop=CreateDesktop(name,IntPtr.Zero,IntPtr.Zero,0,DesktopAccess,IntPtr.Zero);
  if(desktop==IntPtr.Zero) throw Error("Create owned desktop failed");
  try { CheckDesktop(name,desktop); return desktop; }
  catch { CloseDesktop(desktop); throw; }
 }
 public static bool DesktopExists(string name) {
  bool found=false;
  if(!EnumDesktops(GetProcessWindowStation(),(candidate,arg)=>{if(candidate==name)found=true;return true;},IntPtr.Zero)) throw Error("Desktop absence enumeration failed");
  return found;
 }
 public static bool JobExists(string name) {
  var job=OpenJobObject(4,false,name);
  if(job==IntPtr.Zero){int error=Marshal.GetLastWin32Error();if(error==2)return false;throw Error("Job absence query failed");}
  CloseHandle(job);return true;
 }
 public static IntPtr CreateOwnedJob(string name) {
  var job=CreateJobObject(IntPtr.Zero,name);
  int error=Marshal.GetLastWin32Error();
  if(job==IntPtr.Zero) throw Error("Create owned job failed");
  if(error==183) { CloseHandle(job); throw new Exception("Job already exists"); }
  var limits=new JobLimits(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway
  if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits))) { var e=Error("Job limits failed");CloseHandle(job);throw e; }
  return job;
 }
 public static uint ActiveProcesses(IntPtr job) {
  JobAccounting accounting;
  if(!QueryInformationJobObject(job,1,out accounting,Marshal.SizeOf(typeof(JobAccounting)),IntPtr.Zero)) throw Error("Job accounting failed");
  return accounting.active;
 }
 public static void TerminateOwnedJob(IntPtr job) { if(!TerminateJobObject(job,1))throw Error("Owned job termination failed"); }
 public static Child Launch(string desktop, string executable, string command, string cwd) {
  var startup=new StartupInfo(); startup.cb=Marshal.SizeOf(startup); startup.desktop="WinSta0\\"+desktop;
  Child child;
  // Suspended: no child code, Chrome or helpers can run before containment.
  if(!CreateProcess(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,cwd,ref startup,out child)) throw Error("Isolated CreateProcess failed");
  return child; // caller retains the exact suspended-process handles on ALL outcomes
 }
 public static void AssignChild(IntPtr job,Child child) { if(!AssignProcessToJobObject(job,child.process))throw Error("Assign owned job failed"); }
 public static void TerminateChild(Child child) { if(!TerminateProcess(child.process,1) && WaitForSingleObject(child.process,0)!=0)throw Error("Exact suspended/owned child termination failed"); }
 public static void Resume(Child child) { if(ResumeThread(child.thread)==UInt32.MaxValue)throw Error("Resume owned child failed"); }
 public static void GuardLaunchNode(int pid,long ticks,string executable) {
  GuardActor();
  using(var node=Process.GetProcessById(pid)) {
   GuardMember(node);
   if(node.HasExited || node.StartTime.ToUniversalTime().Ticks!=ticks || !String.Equals(node.MainModule.FileName,executable,StringComparison.OrdinalIgnoreCase))throw new Exception("Isolated Node launch identity mismatch");
  }
 }
 public static uint ExitCode(Child child) { uint code; if(!GetExitCodeProcess(child.process,out code))throw Error("Child exit code failed");return code; }
 static string expectedDesktop, jobName, ownerExecutable;
 static int ownerPid;
 static long ownerTicks;
 public static void Configure(string desktop,string job,int owner,long ticks,string executable) {
  expectedDesktop=desktop;jobName=job;ownerPid=owner;ownerTicks=ticks;ownerExecutable=executable;
  GuardActor();
 }
 public static void GuardActor() {
  CheckDesktop(expectedDesktop,GetThreadDesktop(GetCurrentThreadId()));
  using(var owner=Process.GetProcessById(ownerPid)) {
   if(owner.HasExited || owner.StartTime.ToUniversalTime().Ticks!=ownerTicks || !String.Equals(owner.MainModule.FileName,ownerExecutable,StringComparison.OrdinalIgnoreCase)) throw new Exception("Isolation owner identity mismatch");
  }
  GuardMember(Process.GetCurrentProcess());
 }
 static void GuardMember(Process process) {
  var job=OpenJobObject(4,false,jobName); // QUERY only
  if(job==IntPtr.Zero)throw Error("Owned job unavailable");
  try { bool member;if(!IsProcessInJob(process.Handle,job,out member))throw Error("Job membership query failed");if(!member)throw new Exception("Actor/target outside owned job"); }
  finally { CloseHandle(job); }
 }
 public static void GuardProcess(int pid) {
  GuardActor();
  using(var target=Process.GetProcessById(pid)) {
   GuardMember(target);
   // Non-USER threads have no queryable desktop. Membership proves launch
   // containment, NOT a window's desktop: GuardWindow separately proves the
   // exact target USER thread before every window action.
   if(target.HasExited)throw new Exception("Target process exited");
  }
 }
 public static void GuardWindow(IntPtr window, uint expectedPid) {
  GuardActor();
  uint pid;uint thread=GetWindowThreadProcessId(window,out pid);
  if(!IsWindow(window)||thread==0||pid!=expectedPid)throw new Exception("Target window identity mismatch");
  GuardProcess((int)pid);
  CheckDesktop(expectedDesktop,GetThreadDesktop(thread));
 }
}
