plugins {
    // Kotlin comes with the Android plugin (AGP 9).
    id("com.android.application")
}

val media3 = "1.9.0"

// The web UI (Vite build output in ../../dist) is bundled into the APK and served to the
// WebView from https://appassets.androidplatform.net/. Run `npm run build` in the repo
// root first (the CI workflow does this).
val webDist = rootProject.file("../dist")
val webAssetsOut = layout.buildDirectory.dir("generated/webAssets")

// The version people see is package.json's, so a local build can't fall behind it (the CI build
// passes the same value with -PharborVersionName).
val packageJson = rootProject.layout.projectDirectory.file("../package.json")
val packageVersion: String =
    (groovy.json.JsonSlurper().parseText(providers.fileContents(packageJson).asText.get()) as Map<*, *>)["version"] as? String
        ?: throw GradleException("No \"version\" in ${packageJson.asFile}")

val copyWebAssets by tasks.registering(Sync::class) {
    from(webDist)
    into(webAssetsOut.map { it.dir("www") })
    doFirst {
        if (!webDist.resolve("index.html").exists()) {
            throw GradleException("Web build not found at $webDist — run `npm run build` in the repo root first.")
        }
    }
}

android {
    namespace = "app.harbor.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.harbor.android"
        minSdk = 24
        targetSdk = 36
        versionCode = (project.findProperty("harborVersionCode") as String?)?.toInt() ?: 1
        versionName = (project.findProperty("harborVersionName") as String?) ?: packageVersion
        // Phones are ARM: the x86 copies of the FFmpeg decoder only served emulators (an x86
        // emulator or Chromebook with ARM translation still runs this build).
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
    }

    packaging {
        // Debug-agent data from kotlinx-coroutines, never used by the app.
        resources.excludes += "DebugProbesKt.bin"
    }

    signingConfigs {
        // Release key: the .p12 the build writes from the HARBOR_KEYSTORE_BASE64 secret (its path
        // in HARBOR_KEYSTORE_PATH), unlocked by the HARBOR_KEYSTORE_PASSWORD secret. Same key every
        // build => updates install over the previous version. Without it the debug key is used.
        val ksPassword = System.getenv("HARBOR_KEYSTORE_PASSWORD")
        val ksFile = System.getenv("HARBOR_KEYSTORE_PATH")?.takeIf { it.isNotBlank() }?.let { file(it) }
            ?: rootProject.file("keystore/harbor-release.p12")
        if (!ksPassword.isNullOrBlank() && ksFile.exists()) {
            create("release") {
                storeFile = ksFile
                storeType = "pkcs12"
                storePassword = ksPassword
                keyAlias = System.getenv("HARBOR_KEY_ALIAS")?.takeIf { it.isNotBlank() } ?: "harbor"
                keyPassword = System.getenv("HARBOR_KEY_PASSWORD")?.takeIf { it.isNotBlank() } ?: ksPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    sourceSets["main"].apply {
        // A plain folder (AGP 9 takes no Provider here); copyWebAssets fills it before each build.
        assets.srcDir(webAssetsOut.get().asFile)
        // Reuse the launcher icons that already live with the Tauri project.
        res.srcDir("src/main/res-launcher")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
}

tasks.named("preBuild") { dependsOn(copyWebAssets) }

// A release build without the release key still works for trying things locally, but it must not
// pass for a real one: say so whenever such an APK is being made.
if (android.signingConfigs.findByName("release") == null) {
    gradle.taskGraph.whenReady {
        if (hasTask("${project.path}:packageRelease")) {
            logger.warn(
                "WARNING: no release key (HARBOR_KEYSTORE_PASSWORD, and HARBOR_KEYSTORE_PATH or keystore/harbor-release.p12): " +
                    "this release APK is signed with the DEBUG key. Android will refuse to install it over a released copy of Harbor.",
            )
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-ktx:1.11.0")
    // The native Home screen's rows (NativeHome).
    implementation("androidx.recyclerview:recyclerview:1.4.0")
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-exoplayer-hls:$media3")
    implementation("androidx.media3:media3-exoplayer-dash:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    // Media buttons (headset, Bluetooth, car) for the native player.
    implementation("androidx.media3:media3-session:$media3")
    // FFmpeg audio decoders (AC3, E-AC3, DTS, TrueHD, …) that most phones don't ship.
    implementation("org.jellyfin.media3:media3-ffmpeg-decoder:$media3+1")

    testImplementation("junit:junit:4.13.2")
    // The real org.json for JVM tests (android.jar only has stubs of it).
    testImplementation("org.json:json:20240303")
}
