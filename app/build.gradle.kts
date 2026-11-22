import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.xauusd.levels"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.xauusd.levels"
        minSdk = 26
        // 34 keeps the classic (not edge-to-edge) window layout on Android 15+,
        // which is what the WebView UI is laid out for. It also avoids the
        // six-hours-a-day cap Android 15 puts on dataSync foreground services
        // for apps that target 35, which would cut background alerts short.
        targetSdk = 34
        versionCode = 6
        versionName = "1.5.0"
    }

    signingConfigs {
        // A fixed key so every build installs over the previous one. It is
        // committed on purpose and is NOT a secret: see keystore/README.md.
        create("sideload") {
            storeFile = rootProject.file("keystore/sideload.jks")
            storePassword = "xauusd-sideload"
            keyAlias = "sideload"
            keyPassword = "xauusd-sideload"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("sideload")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("sideload")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        // Sideloaded app: the Play Store target-API schedule does not apply.
        disable += "OldTargetApi"
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
