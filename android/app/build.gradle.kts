import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 버전은 데스크톱 앱과 하나로: desktop/package.json 의 version (예: 0.4.0 → versionCode 400)
val siloVersion: String = (JsonSlurper().parse(rootProject.file("../desktop/package.json")) as Map<*, *>)["version"] as String
val siloVersionCode: Int = siloVersion.split(".").map { it.toInt() }.let { (a, b, c) -> a * 10000 + b * 100 + c }

// 서명: GitHub Actions 비밀 값(SILO_KEYSTORE_*)이 있으면 그 키로, 없으면 디버그 키 (내 컴퓨터에서 시험용)
val ksFile = System.getenv("SILO_KEYSTORE_FILE")

android {
    namespace = "org.silo.tablet"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.silo.tablet"
        minSdk = 29 // 안드로이드 10
        targetSdk = 35
        versionCode = siloVersionCode
        versionName = siloVersion
    }

    signingConfigs {
        if (ksFile != null) {
            create("release") {
                storeFile = file(ksFile)
                storePassword = System.getenv("SILO_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SILO_KEY_ALIAS")
                keyPassword = System.getenv("SILO_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (ksFile != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    // 모든 플랫폼이 같이 쓰는 앱 코드(../app)를 그대로 assets 로 (테스트 예시 쪽 이미지는 빼고)
    sourceSets["main"].assets.srcDir(rootProject.file("../app"))
    androidResources {
        ignoreAssetsPattern = "!samples:!.DS_Store:!*.md"
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.core:core:1.13.1")
}
