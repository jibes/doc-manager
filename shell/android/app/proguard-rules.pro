# Methods called from JavaScript must survive shrinking.
-keepclassmembers class app.tessel.viewer.Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
