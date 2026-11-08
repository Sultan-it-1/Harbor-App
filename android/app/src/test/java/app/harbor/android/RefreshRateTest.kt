package app.harbor.android

import org.junit.Assert.assertEquals
import org.junit.Test

class RefreshRateTest {
    private val phone = listOf(60f, 90f, 120f)

    @Test fun uiUsesHighest() = assertEquals(120f, RefreshRate.pick(phone, null))
    @Test fun film24Uses120() = assertEquals(120f, RefreshRate.pick(phone, 24f))
    @Test fun ntscFilmUses120() = assertEquals(120f, RefreshRate.pick(listOf(60f, 120f), 23.976f))
    @Test fun pal25PrefersExactMultiple() = assertEquals(50f, RefreshRate.pick(listOf(50f, 60f, 90f, 120f), 25f))
    @Test fun pal25WithoutMultipleFallsBackToHighest() = assertEquals(120f, RefreshRate.pick(phone, 25f))
    @Test fun thirtyUses120() = assertEquals(120f, RefreshRate.pick(phone, 30f))
    @Test fun sixtyFpsUses120() = assertEquals(120f, RefreshRate.pick(listOf(60f, 90f, 120f, 144f), 60f))
    @Test fun ninetyHzPhoneFor30() = assertEquals(90f, RefreshRate.pick(listOf(60f, 90f), 30f))
}
