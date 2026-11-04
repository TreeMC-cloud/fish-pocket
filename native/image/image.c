// dsh_image: ImageIO behind one N-API call, the codec half of
// engine/shims/sharp.mjs. `transform(data, width, height, orient, quality)`
// decodes the first frame, scales it to exactly width x height, flattens it
// onto white in sRGB, and resolves with JPEG bytes (quality 1-100) or raw RGB
// (quality 0). The shim reads image headers itself: ImageIO reports properties
// a file does not have, and decodes truncated files without complaint.
#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>
#include <node_api.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  CFDataRef input;
  int width, height, orient, quality;
  void *output;
  size_t size;
  const char *error;
} task;

// A thumbnail decodes large JPEGs at reduced scale, and always comes from the
// full image rather than one embedded in the file.
static CGImageRef decode(CFDataRef input, int long_edge, int orient) {
  CGImageSourceRef source = CGImageSourceCreateWithData(input, NULL);
  if (source == NULL) return NULL;
  CFNumberRef edge = CFNumberCreate(NULL, kCFNumberIntType, &long_edge);
  const void *keys[] = {kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceThumbnailMaxPixelSize,
                        kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceShouldCacheImmediately};
  const void *values[] = {kCFBooleanTrue, edge, orient ? kCFBooleanTrue : kCFBooleanFalse, kCFBooleanTrue};
  CFDictionaryRef options = CFDictionaryCreate(NULL, keys, values, 4, &kCFTypeDictionaryKeyCallBacks,
                                               &kCFTypeDictionaryValueCallBacks);
  CGImageRef image = CGImageSourceCreateThumbnailAtIndex(source, 0, options);
  CFRelease(options);
  CFRelease(edge);
  CFRelease(source);
  return image;
}

static CGContextRef flatten(CGImageRef image, int width, int height) {
  CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef context = CGBitmapContextCreate(NULL, (size_t)width, (size_t)height, 8, 0, srgb, kCGImageAlphaNoneSkipLast);
  CGColorSpaceRelease(srgb);
  if (context == NULL) return NULL;
  CGRect rect = CGRectMake(0, 0, width, height);
  CGContextSetRGBFillColor(context, 1, 1, 1, 1);
  CGContextFillRect(context, rect);
  CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
  CGContextDrawImage(context, rect, image);
  return context;
}

static void write_raw(task *t, CGContextRef context) {
  const unsigned char *row = CGBitmapContextGetData(context);
  size_t stride = CGBitmapContextGetBytesPerRow(context);
  t->size = (size_t)t->width * (size_t)t->height * 3;
  unsigned char *out = t->output = malloc(t->size);
  if (out == NULL) {
    t->error = "out of memory";
    return;
  }
  for (int y = 0; y < t->height; y++, row += stride) {
    for (int x = 0; x < t->width; x++, out += 3) memcpy(out, row + (size_t)x * 4, 3);
  }
}

static void write_jpeg(task *t, CGContextRef context) {
  CGImageRef image = CGBitmapContextCreateImage(context);
  CFMutableDataRef data = CFDataCreateMutable(NULL, 0);
  CGImageDestinationRef destination = CGImageDestinationCreateWithData(data, CFSTR("public.jpeg"), 1, NULL);
  if (image != NULL && destination != NULL) {
    double quality = t->quality / 100.0;
    CFNumberRef number = CFNumberCreate(NULL, kCFNumberDoubleType, &quality);
    const void *keys[] = {kCGImageDestinationLossyCompressionQuality};
    const void *values[] = {number};
    CFDictionaryRef options = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
                                                 &kCFTypeDictionaryValueCallBacks);
    CGImageDestinationAddImage(destination, image, options);
    if (CGImageDestinationFinalize(destination)) {
      t->size = (size_t)CFDataGetLength(data);
      t->output = malloc(t->size);
      if (t->output != NULL) memcpy(t->output, CFDataGetBytePtr(data), t->size);
    }
    CFRelease(options);
    CFRelease(number);
  }
  if (t->output == NULL) t->error = "could not encode the image";
  if (destination != NULL) CFRelease(destination);
  if (image != NULL) CGImageRelease(image);
  CFRelease(data);
}

static void execute(napi_env env, void *data) {
  task *t = data;
  CGImageRef image = decode(t->input, t->width > t->height ? t->width : t->height, t->orient);
  if (image == NULL) {
    t->error = "could not decode the image";
    return;
  }
  CGContextRef context = flatten(image, t->width, t->height);
  CGImageRelease(image);
  if (context == NULL) {
    t->error = "could not allocate the image";
    return;
  }
  if (t->quality == 0) write_raw(t, context);
  else write_jpeg(t, context);
  CGContextRelease(context);
}

static void complete(napi_env env, napi_status status, void *data) {
  task *t = data;
  napi_value value;
  if (t->error == NULL && status == napi_ok &&
      napi_create_buffer_copy(env, t->size, t->output, NULL, &value) == napi_ok) {
    napi_resolve_deferred(env, t->deferred, value);
  } else {
    napi_value message;
    napi_create_string_utf8(env, t->error ? t->error : "image task failed", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, NULL, message, &value);
    napi_reject_deferred(env, t->deferred, value);
  }
  napi_delete_async_work(env, t->work);
  CFRelease(t->input);
  free(t->output);
  free(t);
}

static napi_value transform(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5], promise, name;
  void *bytes;
  size_t length;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  task *t = calloc(1, sizeof *t);
  if (t == NULL || argc != 5 || napi_get_buffer_info(env, argv[0], &bytes, &length) != napi_ok ||
      napi_get_value_int32(env, argv[1], &t->width) != napi_ok || napi_get_value_int32(env, argv[2], &t->height) != napi_ok ||
      napi_get_value_int32(env, argv[3], &t->orient) != napi_ok || napi_get_value_int32(env, argv[4], &t->quality) != napi_ok ||
      t->width < 1 || t->height < 1) {
    free(t);
    napi_throw_type_error(env, NULL, "transform(data, width, height, orient, quality)");
    return NULL;
  }
  t->input = CFDataCreate(NULL, bytes, (CFIndex)length);
  napi_create_promise(env, &t->deferred, &promise);
  napi_create_string_utf8(env, "dsh_image", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, NULL, name, execute, complete, t, &t->work);
  napi_queue_async_work(env, t->work);
  return promise;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "transform", NAPI_AUTO_LENGTH, transform, NULL, &fn);
  napi_set_named_property(env, exports, "transform", fn);
  return exports;
}

#ifdef DSH_IMAGE_LINKED
// Linked into the app: registered before Node starts, reached through
// process._linkedBinding('dsh_image') from any thread's environment.
static napi_module module = {1, 0, __FILE__, init, "dsh_image", NULL, {0}};
__attribute__((constructor)) static void register_module(void) { napi_module_register(&module); }
#else
NAPI_MODULE(dsh_image, init)
#endif
