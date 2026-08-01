#include "xsmc.h"
#include "esp_heap_caps.h"

void xs_memory_status(xsMachine *the)
{
	size_t psramTotal;

	xsmcVars(1);
	xsmcSetNewObject(xsResult);

	psramTotal = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);

	xsmcSetBoolean(xsVar(0), psramTotal > 0);
	xsmcSet(xsResult, xsID("psramInitialized"), xsVar(0));

	xsmcSetInteger(xsVar(0), psramTotal);
	xsmcSet(xsResult, xsID("psramTotal"), xsVar(0));

	xsmcSetInteger(xsVar(0),
		heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
	xsmcSet(xsResult, xsID("psramFree"), xsVar(0));

	xsmcSetInteger(xsVar(0),
		heap_caps_get_minimum_free_size(MALLOC_CAP_SPIRAM));
	xsmcSet(xsResult, xsID("psramMinimum"), xsVar(0));

	xsmcSetInteger(xsVar(0),
		heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM));
	xsmcSet(xsResult, xsID("psramLargest"), xsVar(0));

	xsmcSetInteger(xsVar(0),
		heap_caps_get_free_size(
			MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
	xsmcSet(xsResult, xsID("internalFree"), xsVar(0));

	xsmcSetInteger(xsVar(0),
		heap_caps_get_minimum_free_size(
			MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
	xsmcSet(xsResult, xsID("internalMinimum"), xsVar(0));

	xsmcSetInteger(xsVar(0),
		heap_caps_get_free_size(
			MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA));
	xsmcSet(xsResult, xsID("dmaFree"), xsVar(0));
}