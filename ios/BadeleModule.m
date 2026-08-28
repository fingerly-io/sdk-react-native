//
//  The Objective-C declarations React Native's bridge reads.
//
//  React Native discovers a module and its methods through the `RCT_EXTERN_*`
//  macros, which register them with the bridge at load time. A Swift class
//  marked `@objc` is visible to the runtime but not to the bridge's registry —
//  the macros are what put it there, and they only exist in Objective-C. Hence
//  this file: it is a declaration of what the Swift alongside it implements,
//  and it contains no logic for the same reason the Swift contains none.
//
//  The signatures have to match `BadeleModule.swift` exactly, including the
//  selector fragments. A mismatch is not a compile error in either language;
//  it is a method JavaScript calls that never arrives.
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE (Badele, NSObject)

RCT_EXTERN_METHOD(configure:(NSString *)apiKey
                  endpoint:(NSString *)endpoint
                  platform:(NSString *)platform)

RCT_EXTERN_METHOD(identify:(NSString *_Nullable)tag
                  submit:(nonnull NSNumber *)submit
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(collect:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
