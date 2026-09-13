package io.badele.reactnative

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * What React Native's autolinking registers.
 *
 * There is no iOS equivalent of this file, and that asymmetry is the platforms'
 * rather than ours: iOS discovers a module from the `RCT_EXTERN_MODULE` macro
 * in `BadeleModule.m`, and Android needs a package class naming it.
 */
class BadelePackage : BaseReactPackage() {

    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == MODULE_NAME) BadeleModule(reactContext) else null

    @Suppress("DEPRECATION")
    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
        mapOf(
            MODULE_NAME to ReactModuleInfo(
                MODULE_NAME,
                BadeleModule::class.java.name,
                false, // canOverrideExistingModule
                false, // needsEagerInit
                true, // hasConstants; retained for React Native 0.73 compatibility
                false, // isCxxModule
                false, // isTurboModule
            ),
        )
    }

    private companion object {
        const val MODULE_NAME = "Badele"
    }
}
