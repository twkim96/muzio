plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.twkim.videiomusic"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.twkim.videiomusic"
        minSdk = 26
        targetSdk = 36
        versionCode = 14
        versionName = "1.4.6"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    testImplementation("junit:junit:4.13.2")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.material3:material3:1.4.0")
    implementation("androidx.compose.foundation:foundation:1.11.2")
    implementation("androidx.compose.ui:ui:1.11.2")
    implementation("androidx.compose.ui:ui-tooling-preview:1.11.2")
    implementation("androidx.datastore:datastore-preferences:1.2.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.media3:media3-exoplayer:1.10.1")
    implementation("androidx.media3:media3-session:1.10.1")
    implementation("androidx.media3:media3-ui:1.10.1")
    implementation("io.coil-kt.coil3:coil-compose:3.3.0")
    implementation("io.coil-kt.coil3:coil-network-okhttp:3.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    debugImplementation("androidx.compose.ui:ui-tooling:1.11.2")
}

// The APK always contains the current React UI. Never maintain a second copy
// of these assets or silently package an old web_app/dist directory.
val sharedWebRoot = rootProject.projectDir.resolve("../web_app")
val sharedWebAssets = layout.buildDirectory.dir("generated/sharedWebAssets")
val buildSharedWeb by tasks.registering(Exec::class) {
    workingDir(sharedWebRoot)
    inputs.dir(sharedWebRoot.resolve("src"))
    inputs.dir(sharedWebRoot.resolve("public"))
    inputs.files(fileTree(sharedWebRoot) {
        include("package*.json", "*.config.*", "tsconfig.json", "index.html")
    })
    outputs.dir(sharedWebAssets)
    environment("VITE_MUZIO_ANDROID", "1")
    commandLine("npm", "run", "build", "--", "--outDir",
        sharedWebAssets.get().dir("muzio-web").asFile.absolutePath)
}
android.sourceSets.getByName("main").assets.srcDir(sharedWebAssets.get().asFile)
tasks.named("preBuild").configure { dependsOn(buildSharedWeb) }
