plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Version from CI (tag v1.2.3 → versionName 1.2.3, run number → versionCode); local builds get 1.0.0 (1).
val versionNameProp = (findProperty("tessel.versionName") as String?) ?: "1.0.0"
val versionCodeProp = ((findProperty("tessel.versionCode") as String?) ?: "1").toInt()

// Release signing from environment (CI secrets). Without them, release builds use the debug key: fine for
// testing, but such APKs can't update an installed release.
val keystore = System.getenv("TESSEL_KEYSTORE_FILE")?.let { file(it) }?.takeIf { it.exists() }

android {
    namespace = "app.tessel.viewer"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.tessel.viewer"
        minSdk = 26
        targetSdk = 36
        versionCode = versionCodeProp
        versionName = versionNameProp
    }

    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = keystore
                storePassword = System.getenv("TESSEL_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("TESSEL_KEY_ALIAS")
                keyPassword = System.getenv("TESSEL_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (keystore != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    // The bundled web app is already compressed where it matters (wasm, models); don't double-compress.
    androidResources {
        noCompress += listOf("wasm", "gz")
        // The default pattern skips "_*" directories, which would drop the web app's _expo/ bundle.
        ignoreAssetsPattern = "!.svn:!.git:!.ds_store:!*.scc:!CVS:!thumbs.db:!picasa.ini:!*~"
    }

    // A system call without its permission in the manifest fails only at run time: stop the release build instead.
    lint {
        fatal += "MissingPermission"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.1")
    implementation("com.squareup.okhttp3:okhttp-dnsoverhttps:4.12.1")
}
