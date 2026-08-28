package io.badele.reactnative

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * What React Native's autolinking registers.
 *
 * There is no iOS equivalent of this file, and that asymmetry is the platforms'
 * rather than ours: iOS discovers a module from the `RCT_EXTERN_MODULE` macro
 * in `BadeleModule.m`, and Android needs a package class naming it.
 */
class BadelePackage : ReactPackage {

    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
        listOf(BadeleModule(context))

    /** No views. This SDK draws nothing. */
    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
