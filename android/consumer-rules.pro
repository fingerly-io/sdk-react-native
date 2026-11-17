# Optional Fingerly artifacts are compileOnly in the bridge and only present at
# runtime when the host application explicitly opts in via its own dependencies.
-dontwarn io.fingerly.sdk.appchecks.**
-dontwarn io.fingerly.sdk.playintegrity.**
