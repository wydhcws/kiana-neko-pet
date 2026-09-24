// 读取 macOS「正在播放」信息（波点音乐、Apple Music、Spotify 等都会上报），每秒输出一行 JSON
// 编译：npm run build:native
#import <AppKit/AppKit.h>
#include <dlfcn.h>

typedef void (^InfoBlock)(NSDictionary *);
typedef void (^PidBlock)(int);
static void (*getInfo)(dispatch_queue_t, InfoBlock);
static void (*getPid)(dispatch_queue_t, PidBlock);

static NSString *clean(id v) {
  if (![v isKindOfClass:[NSString class]]) return @"";
  // 波点的歌手名里夹着零宽空格
  return [[(NSString *)v stringByReplacingOccurrencesOfString:@"​" withString:@""]
          stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

static void poll(void) {
  getPid(dispatch_get_main_queue(), ^(int pid) {
    NSString *bundle = [NSRunningApplication runningApplicationWithProcessIdentifier:pid].bundleIdentifier ?: @"";
    getInfo(dispatch_get_main_queue(), ^(NSDictionary *d) {
      NSMutableDictionary *o = [NSMutableDictionary dictionary];
      o[@"bundle"] = bundle;
      o[@"title"] = clean(d[@"kMRMediaRemoteNowPlayingInfoTitle"]);
      o[@"artist"] = clean(d[@"kMRMediaRemoteNowPlayingInfoArtist"]);
      o[@"album"] = clean(d[@"kMRMediaRemoteNowPlayingInfoAlbum"]);
      o[@"duration"] = d[@"kMRMediaRemoteNowPlayingInfoDuration"] ?: @0;
      o[@"elapsed"] = d[@"kMRMediaRemoteNowPlayingInfoElapsedTime"] ?: @0;
      o[@"rate"] = d[@"kMRMediaRemoteNowPlayingInfoPlaybackRate"] ?: @0;
      NSDate *ts = d[@"kMRMediaRemoteNowPlayingInfoTimestamp"];
      o[@"timestamp"] = @(ts ? ts.timeIntervalSince1970 * 1000 : 0);
      NSData *json = [NSJSONSerialization dataWithJSONObject:o options:0 error:nil];
      if (json) {
        fwrite(json.bytes, 1, json.length, stdout);
        fputc('\n', stdout);
        fflush(stdout);
      }
    });
  });
}

int main(void) {
  @autoreleasepool {
    void *h = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote", RTLD_NOW);
    getInfo = dlsym(h, "MRMediaRemoteGetNowPlayingInfo");
    getPid = dlsym(h, "MRMediaRemoteGetNowPlayingApplicationPID");
    if (!getInfo || !getPid) { fprintf(stderr, "MediaRemote unavailable\n"); return 1; }
    [NSTimer scheduledTimerWithTimeInterval:1.0 repeats:YES block:^(NSTimer *t) { poll(); }];
    poll();
    // 父进程退出时 stdout 会断，写失败就退出
    signal(SIGPIPE, SIG_DFL);
    [[NSRunLoop mainRunLoop] run];
  }
  return 0;
}
