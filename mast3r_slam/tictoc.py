import torch
import time


class Timer:
    """
    Simple timer which takes forces cuda synchronization.
    """

    def __init__(self):
        self.timers_start = []
        self.device_type = None

    def start(self):
        if torch.cuda.is_available():
            self.device_type = "cuda"
            start_t = torch.cuda.Event(enable_timing=True)
            start_t.record()
            self.timers_start.append(start_t)
            return

        self.device_type = "cpu"
        self.timers_start.append(time.perf_counter())

    def stop(self, tag=None):
        start_t = self.timers_start.pop()
        tag = f"{tag}: " if tag else ""
        if self.device_type == "cuda":
            end_t = torch.cuda.Event(enable_timing=True)
            end_t.record()
            torch.cuda.synchronize()
            elapsed_time_s = start_t.elapsed_time(end_t) / 1000
        else:
            elapsed_time_s = time.perf_counter() - float(start_t)
        print(f"{tag}Elapsed {elapsed_time_s}s")
        return elapsed_time_s


_global_timer = Timer()
tic = _global_timer.start
toc = _global_timer.stop
